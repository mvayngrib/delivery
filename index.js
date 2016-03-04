
var cyclist = require('cyclist');
var util = require('util');
var EventEmitter = require('events').EventEmitter;
var debug = require('debug')('utp')
var BitArray = require('./bit-array')

var EXTENSION = 0;
var VERSION   = 1;
var UINT16    = 0xffff;
var ID_MASK   = 0xf << 4;
var MTU       = 1400;

var PACKET_DATA  = 0 << 4;
var PACKET_FIN   = 1 << 4;
var PACKET_STATE = 2 << 4;
var PACKET_RESET = 3 << 4;
var PACKET_SYN   = 4 << 4;

var MIN_PACKET_SIZE = 20;
var DEFAULT_WINDOW_SIZE = 1 << 18;
var CLOSE_GRACE = 3000;
var KEEP_ALIVE_INTERVAL = 10*1000;
var RESEND_INTERVAL = 100;

var BUFFER_SIZE = 512;
var RECV_IDS = BitArray(UINT16);

var noop = function () {}

var uint32 = function(n) {
  return n >>> 0;
};

var uint16 = function(n) {
  return n & UINT16;
};

var hrtime = process.hrtime ?
  process.hrtime.bind(process) :
  require('browser-process-hrtime')

var timestamp = function() {
  var offset = hrtime();
  var then = Date.now() * 1000;

  return function() {
    var diff = hrtime(offset);
    return uint32(then + 1000000 * diff[0] + ((diff[1] / 1000) | 0));
  };
}();

var bufferToPacket = function(buffer) {
  var packet = {};
  packet.id = buffer[0] & ID_MASK;
  packet.connection = buffer.readUInt16BE(2);
  packet.timestamp = buffer.readUInt32BE(4);
  packet.timediff = buffer.readUInt32BE(8);
  packet.window = buffer.readUInt32BE(12);
  packet.seq = buffer.readUInt16BE(16);
  packet.ack = buffer.readUInt16BE(18);
  packet.data = buffer.length > 20 ? buffer.slice(20) : null;
  return packet;
};

var packetToBuffer = function(packet) {
  var buffer = new Buffer(20 + (packet.data ? packet.data.length : 0));
  buffer[0] = packet.id | VERSION;
  buffer[1] = EXTENSION;
  buffer.writeUInt16BE(packet.connection, 2);
  buffer.writeUInt32BE(packet.timestamp, 4);
  buffer.writeUInt32BE(packet.timediff, 8);
  buffer.writeUInt32BE(packet.window, 12);
  buffer.writeUInt16BE(packet.seq, 16);
  buffer.writeUInt16BE(packet.ack, 18);
  if (packet.data) packet.data.copy(buffer, 20);
  return buffer;
};

var packetType = function(packet) {
  return packet.id === PACKET_DATA
    ? 'data' : packet.id === PACKET_STATE
    ? 'ack' : packet.id === PACKET_SYN
    ? 'syn' : packet.id === PACKET_FIN
    ? 'fin' : 'reset'
}

var stateName = function(state) {
  for (var p in STATE) {
    if (state === STATE[p]) return p
  }
}

var createPacket = function(connection, id, data) {
  return {
    id: id,
    connection: id === PACKET_SYN ? connection._recvId : connection._sendId,
    seq: connection._seq,
    ack: connection._ack,
    timestamp: timestamp(),
    timediff: 0,
    window: DEFAULT_WINDOW_SIZE,
    data: data,
    sent: 0
  };
};

var nonRepeatRandom = function () {
  var rand
  do {
    rand = Math.random() * UINT16 | 0
  } while (RECV_IDS.get(rand))

  RECV_IDS.set(rand, 1)
  return rand
}

var CID = 0
var Connection = function(options) {
  var self = this;
  options = options || {}

  this._maxPayloadSize = options.maxPayloadSize || MTU
  var resendInterval = options.resendInterval || RESEND_INTERVAL
  var keepAliveInteravl = options.keepAliveInteravl || KEEP_ALIVE_INTERVAL

  EventEmitter.call(this)

  this.setMaxListeners(0)
  this._id = CID++
  this._reset()

  var resend = setInterval(this._resend.bind(this), resendInterval);
  var keepAlive = setInterval(this._keepAlive.bind(this), keepAliveInteravl);

  this.once('destroy', function() {
    this._debug('destroyed')
    clearInterval(resend);
    clearInterval(keepAlive);
  });
};

util.inherits(Connection, EventEmitter);

Connection.prototype._onconnected = function () {
  this._connecting = false
  this.emit('connect')
}

Connection.prototype._debug = function () {
  var args = [].slice.call(arguments)
  args.unshift(this._id)
  return debug(args.join(' '))
}

// Connection.prototype.setTimeout = function(millis, cb) {
//   var self = this

//   this._clearIdleTimeout()
//   if (!millis) return

//   this._idleTimeoutMillis = millis
//   this._idleTimeout = setTimeout(function () {
//     self._clearIdleTimeout()
//     self.emit('timeout', millis)
//   }, millis)

//   if (this._idleTimeout.unref) {
//     this._idleTimeout.unref()
//   }

//   if (cb) this.once('timeout', cb)
// };

// Connection.prototype._clearIdleTimeout = function () {
//   clearTimeout(this._idleTimeout)
//   delete this._idleTimeout
//   delete this._idleTimeoutMillis
// }

// Connection.prototype.close = function (cb) {
//   // close nicely
//   var self = this

//   if (this._closing) throw new Error('closing')

//   this._closing = true
//   this._closeCB = closeCB
//   if (!this._inflightPackets) return closeCB()

//   this._debug('closing, ' + this._inflightPackets + ' in flight')
//   setTimeout(closeCB, CLOSE_GRACE)

//   function closeCB () {
//     if (self._destroyed) return
//     if (cb) cb()

//     self.destroy()
//   }
// }

Connection.prototype.destroy = function () {
  if (this._destroyed) throw new Error('destroyed')

  this._destroyed = true
  this.emit('destroy')
};

Connection.prototype.send = function (data, ondelivered) {
  var self = this
  if (this._destroyed || this._closing) return

  if (!this._recvId) {
    this._recvId = nonRepeatRandom()
    this._sendId = uint16(this._recvId + 1)
    this._connId = this._recvId
    this._syn = createPacket(this, PACKET_SYN, null)
    this._sendOutgoing(this._syn)
  }

  if (this._destroyed) throw new Error('this instance has been destroyed!')

  if (!Buffer.isBuffer(data)) {
    if (typeof data === 'object') {
      data = JSON.stringify(data)
    }

    if (typeof data === 'string') {
      data = new Buffer(data)
    } else {
      throw new Error('expected plain javascript object, Buffer, or string')
    }
  }

  var packetsToGo = this._countRequiredPackets(data)

  this._msgQueue.push([data, ondelivered]) // normalized args
  // register callback for ack for last piece
  this._deliveryCallbacks.put(uint16(this._seq + packetsToGo), function () {
    var args = self._msgQueue.shift()
    if (args[1]) args[1]()
  })

  this._debug('queueing', data.toString())
  this._write(data)
}

Connection.prototype._write = function(data) {
  var self = this

  if (this._connecting) return this._writeOnce('connect', data);

  while (this._writable()) {
    var payload = this._payload(data);

    // this._debug('queueing data', payload.toString())
    this._sendOutgoing(createPacket(this, PACKET_DATA, payload));

    if (payload.length === data.length) return
    data = data.slice(payload.length);
  }

  this._writeOnce('flush', data);
};

Connection.prototype._writeOnce = function(event, data) {
  var once = function () {
    this._write(data);
  }

  var handlers = this._subscribedTo[event] = this._subscribedTo[event] || []
  handlers.push(once)
  this.once(event, once);
};

Connection.prototype._writable = function() {
  return this._inflightPackets < BUFFER_SIZE-1;
};

Connection.prototype._payload = function(data) {
  if (data.length > MTU) return data.slice(0, MTU);
  return data;
};

Connection.prototype._countRequiredPackets = function (data) {
  return data.length / this._maxPayloadSize | 0
}

Connection.prototype._resend = function() {
  var offset = this._seq - this._inflightPackets;
  var first = this._outgoing.get(offset);
  if (!first) return;

  var timeout = 500000;
  var now = timestamp();

  if (uint32(first.sent - now) < timeout) return;

  for (var i = 0; i < this._inflightPackets; i++) {
    var packet = this._outgoing.get(offset+i);
    this._debug('resending ' + packetType(packet))
    if (uint32(packet.sent - now) >= timeout) this._transmit(packet);
  }
};

Connection.prototype._keepAlive = function() {
  if (this._alive) return this._alive = false;
  this._sendAck();
};

Connection.prototype._recvAck = function(ack) {
  var offset = this._seq - this._inflightPackets;
  var acked = uint16(ack - offset)+1;

  if (acked >= BUFFER_SIZE) return; // sanity check

  this._debug(acked + ' packets acked')
  var callbacks = []
  for (var i = 0; i < acked; i++) {
    var seq = offset+i
    var packet = this._outgoing.del(seq)
    var cb = this._deliveryCallbacks.del(seq)
    if (cb) callbacks.push(cb)

    this._inflightPackets--
  }

  process.nextTick(function () {
    callbacks.forEach(function (cb) {
      cb()
    })
  })

  if (!this._inflightPackets) {
    this.emit('flush');
  }
};

Connection.prototype._reset = function (resend) {
  var self = this

  if (this._msgQueue) {
    for (var e in this._subscribedTo) {
      for (var i = 0; i < this._subscribedTo[e].length; i++) {
        this.removeListener(e, this._subscribedTo[e][i])
      }
    }

    this._debug('resetting')
  }

  var msgs = resend && this._msgQueue && this._msgQueue.slice()

  this._subscribedTo = {}
  this._msgQueue = []
  this._deliveryCallbacks = cyclist(BUFFER_SIZE)
  this._outgoing = cyclist(BUFFER_SIZE);
  this._incoming = cyclist(BUFFER_SIZE);

  this._inflightPackets = 0;
  this._alive = false;

  this._connecting = true;
  this._connId = null
  this._recvId = null; // tmp value for v8 opt
  this._sendId = null; // tmp value for v8 opt
  this._ack = 0;
  this._seq = (Math.random() * UINT16) | 0;
  // this._synack = null;

  if (msgs) {
    msgs.forEach(function (args) {
      self.send.apply(self, args)
    })
  }
}

Connection.prototype._millisSinceLastReceived = function () {
  return Date.now() - (this._lastReceivedTimestamp || 0)
}

Connection.prototype._finishConnecting = function (packet) {
  if (packet.id === PACKET_SYN) {
    // our conn id should win
    // ignore their syn and keep resending ours
    if (this._connId > packet.connection) {
      this._debug('our conn wins')
      return
    }

    if (this._connId === packet.connection) {
      // this._debug('resetting due to connection id collision')
      // this._reset(true)
      this._sendAck()
      return
    }

    // their conn id won
    this._debug('their conn wins')
    if (this._syn) this._cancelPacket(this._syn)

    this._recvId = uint16(packet.connection + 1)
    this._sendId = packet.connection
    this._connId = this._sendId
    this._ack = uint16(packet.seq);
    return this._sendAck()
  }

  var isInitiator = this._sendId > this._recvId
  if (packet.id === PACKET_STATE) {
    if (!isInitiator) return

    this._ack = uint16(packet.seq-1);
    this._recvAck(packet.ack);
    return this._onconnected()
  }

  if (packet.id === PACKET_DATA) {
    this._incoming.put(packet.seq, packet)
    // wait for PACKET_STATE
    if (isInitiator) return

    this._recvAck(packet.ack)
    return this._onconnected()
  }
}

Connection.prototype.receive = function(buffer) {
  if (this._destroyed) {
    this._debug('cannot receive, am destroyed')
    return
  }

  var packet = bufferToPacket(buffer)
  this._debug('connected: ' + (!this._connecting) + '\n    received: ' + packetType(packet) + '\n    with seq: ' + packet.seq + '\n    and ack: ' + packet.ack)

  this._lastReceivedTimestamp = Date.now()
  if ('_idleTimeout' in this) {
    this.setTimeout(this._idleTimeoutMillis)
  }

  if (packet.id === PACKET_RESET) {
    this._debug('resetting due to received RESET packet')
    return this._reset()
    // return this.destroy()
  }

  if (this._connecting) {
    this._finishConnecting(packet)
    if (this._connecting) return
  }

  if (packet.id === PACKET_SYN) {
    if (packet.connection !== this._sendId) {
      this._debug('resetting due to new SYN received')
      this._reset(true)
      return this.receive(buffer)
    } else {
      // ignore it
      return

      // // we're on the same connection
      // // ack the syn
      // var ack = createPacket(this, PACKET_STATE, null)
      // ack.ack = packet.seq
      // return this._transmit(ack)
    }
  }

  if (packet.id === PACKET_STATE) return

  if (uint16(packet.seq - this._ack) >= BUFFER_SIZE) {
    this._debug('acking old packet')
    return this._sendAck(); // old packet
  }

  this._incoming.put(packet.seq, packet)

  while (packet = this._incoming.del(this._ack+1)) {
    this._ack = uint16(this._ack+1);

    if (packet.id === PACKET_DATA) {
      this.emit('message', packet.data)
    }

    if (packet.id === PACKET_FIN) {
      return this.destroy()
    }
  }

  this._sendAck()
};

Connection.prototype._sendAck = function() {
  // this._debug('acking', this._seq, this._ack)
  this._transmit(createPacket(this, PACKET_STATE, null)); // TODO: make this delayed
};

Connection.prototype._sendOutgoing = function(packet) {
  this._outgoing.put(packet.seq, packet);
  this._seq = uint16(this._seq + 1);
  this._inflightPackets++;
  this._transmit(packet);
};

Connection.prototype._cancelPacket = function(packet) {
  var outgoing = this._outgoing.del(packet.seq)
  if (outgoing === packet) {
    this._inflightPackets--
  }
}

Connection.prototype._transmit = function(packet) {
  packet.sent = packet.sent === 0 ? packet.timestamp : timestamp();
  var message = packetToBuffer(packet);
  this._alive = true;
  this._debug('sending ' + packetType(packet), packet.seq, ', acking ' + packet.ack)
  this.emit('send', message)
};

exports.packetToBuffer = packetToBuffer
exports.bufferToPacket = bufferToPacket
exports.Connection = module.exports = Connection
