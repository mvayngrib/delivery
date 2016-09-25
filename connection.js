var cyclist = require('cyclist')
var util = require('util')
var EventEmitter = require('events').EventEmitter
var debug = require('debug')('sendy')
var reemit = require('re-emitter')
var BitArray = require('./bit-array')
var utils = require('./utils')

var EXTENSION    = 0
var VERSION      = 1
var UINT16       = 0xffff
var ID_MASK      = 0xf << 4
var MTU          = 1500 // tcp-ish

var PACKET_DATA  = 0 << 4
var PACKET_FIN   = 1 << 4
var PACKET_STATE = 2 << 4
var PACKET_RESET = 3 << 4
var PACKET_SYN   = 4 << 4

var MIN_PACKET_SIZE     = 20
var DEFAULT_WINDOW_SIZE = 1 << 18
var CLOSE_GRACE         = 3000
var KEEP_ALIVE_INTERVAL = 10 * 1000
var RESEND_INTERVAL     = 1000

var BUFFER_SIZE         = 512
var RECV_IDS = BitArray(UINT16)

var uint32 = function (n) {
  return n >>> 0
}

var uint16 = function (n) {
  return n & UINT16
}

var hrtime = process.hrtime ?
  process.hrtime.bind(process) :
  require('browser-process-hrtime')

var timestamp = function () {
  var offset = hrtime()
  var then = Date.now() * 1000

  return function () {
    var diff = hrtime(offset)
    return uint32(then + 1000000 * diff[0] + ((diff[1] / 1000) | 0))
  }
}()

var bufferToPacket = function (buffer) {
  var packet = {}
  packet.id = buffer[0] & ID_MASK
  packet.connection = buffer.readUInt16BE(2)
  packet.timestamp = buffer.readUInt32BE(4)
  packet.timediff = buffer.readUInt32BE(8)
  packet.window = buffer.readUInt32BE(12)
  packet.seq = buffer.readUInt16BE(16)
  packet.ack = buffer.readUInt16BE(18)
  packet.data = buffer.length > 20 ? buffer.slice(20) : null
  return packet
}

var packetToBuffer = function (packet) {
  if (packet.buffer) return packet.buffer

  var buffer = new Buffer(20 + (packet.data ? packet.data.length : 0))
  buffer[0] = packet.id | VERSION
  buffer[1] = EXTENSION
  buffer.writeUInt16BE(packet.connection, 2)
  buffer.writeUInt32BE(packet.timestamp, 4)
  buffer.writeUInt32BE(packet.timediff, 8)
  buffer.writeUInt32BE(packet.window, 12)
  buffer.writeUInt16BE(packet.seq, 16)
  buffer.writeUInt16BE(packet.ack, 18)
  if (packet.data) packet.data.copy(buffer, 20)
  return packet.buffer = buffer
}

var packetType = function (packet) {
  return packet.id === PACKET_DATA
    ? 'data' : packet.id === PACKET_STATE
      ? 'ack' : packet.id === PACKET_SYN
        ? 'syn' : packet.id === PACKET_FIN
          ? 'fin' : 'reset'
}

var stateName = function (state) {
  for (var p in STATE) {
    if (state === STATE[p]) return p
  }
}

var createPacket = function (connection, id, data) {
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
  }
}

var nonRepeatRandom = function () {
  var rand
  do {
    rand = Math.random() * UINT16 | 0
  } while (RECV_IDS.get(rand))

  RECV_IDS.set(rand, 1)
  return rand
}

var noop = function () {}
var CID = 0
var CONNECTIONS = {}

function Connection (options, syn) {
  var self = this
  options = options || {}

  this._mtu = options.mtu || MTU
  var resendInterval = options.resendInterval || RESEND_INTERVAL
  var keepAliveInterval = options.keepAliveInterval || KEEP_ALIVE_INTERVAL

  EventEmitter.call(this)

  this.setMaxListeners(0)
  this._id = CID++
  this._paused = false
  this._msgQueue = []
  this._writeBuffer = []
  this._deliveryCallbacks = cyclist(BUFFER_SIZE)
  this._outgoing = cyclist(BUFFER_SIZE)
  this._incoming = cyclist(BUFFER_SIZE)

  this._inflightPackets = 0
  this._alive = false

  var resend = setInterval(this._resend.bind(this), resendInterval)
  var keepAlive = setInterval(this._keepAlive.bind(this), keepAliveInterval)

  this.once('close', function () {
    self._debug('closed')
    clearInterval(resend)
    clearInterval(keepAlive)
    self.clearTimeout()
    self._cancelPending()
    delete CONNECTIONS[self._id]
  })

  ;['connect', 'resume', 'flush'].forEach(function (event) {
    self.on(event, self._flush)
  })

  Object.defineProperty(this, '_backedUp', {
    get: function () {
      return self._writeBuffer.reduce(function (total, data) {
        return total + data.length
        // return total + self._countRequiredPackets(data)
      }, 0)
    }
  })

  this._initiator = !syn
  if (this._initiator) {
    this._connecting = true
    this._recvId = nonRepeatRandom()
    this._sendId = uint16(this._recvId + 1)
    this._seq = (Math.random() * UINT16) | 0
    this._ack = 0
    this._sendOutgoing(createPacket(this, PACKET_SYN, null))
  } else {
    this._recvId = uint16(syn.connection+1)
    this._sendId = syn.connection
    this._seq = (Math.random() * UINT16) | 0
    this._ack = syn.seq
    this._sendAck()
    this._onconnected()
  }

  this._debug('created new ' + (this._initiator ? 'outbound' : 'inbound') + ' connection')
}

Connection.MTU = MTU
util.inherits(Connection, EventEmitter)

Connection.prototype._onconnected = function () {
  this._debug('connected')
  this._connecting = false
  this.emit('connect')
}

Connection.prototype._debug = function () {
  var args = [].slice.call(arguments)
  args.unshift('connection', this._id)
  return debug(args.join(' '))
}

Connection.prototype.setTimeout = function(millis, cb) {
  var self = this

  this.clearTimeout()
  if (!millis) return

  this._idleTimeoutMillis = millis
  // if (this._connecting) {
  //   return this.once('connect', this.setTimeout.bind(this, millis, cb))
  // }

  this._idleTimeout = setTimeout(function () {
    if (self.listenerCount('timeout')) {
      self.emit('timeout', millis)
    } else {
      self._debug('timed out')
      self.close()
    }
  }, millis)

  if (this._idleTimeout.unref) {
    this._idleTimeout.unref()
  }

  if (cb) this.once('timeout', cb)
}

Connection.prototype.clearTimeout = function () {
  clearTimeout(this._idleTimeout)
  delete this._idleTimeout
  delete this._idleTimeoutMillis
}

Connection.prototype.close =
Connection.prototype.destroy = function () {
  if (this._closed) throw new Error('closed')

  this._debug('closing')
  this.clearTimeout()
  this._closed = true
  this.emit('close')
}

Connection.prototype.send = function (data, ondelivered) {
  var self = this
  if (this._closed) return

  this.resume()

  data = utils.toBuffer(data)
  this._msgQueue.push([data, ondelivered]) // normalized args

  // register callback for ack for last piece
  var bytesQueued = this._backedUp + data.length
  var packetsTogo = Math.ceil(bytesQueued / this._mtu)
  this._putDeliveryCallback(packetsTogo, function (err) {
    var args = self._msgQueue.shift()
    if (args && args[1]) args[1](err)
  })

  this._bufferData(data)
  this._flush()
}

Connection.prototype._putDeliveryCallback = function (numAcks, fn) {
  // how many times to go around the circular buffer
  fn._sendyRoundsLeft = Math.ceil(numAcks / BUFFER_SIZE)
  var idx = this._seq + numAcks - 1 // current seq value is for the next packet
  var cbs = this._deliveryCallbacks.get(idx) || []
  cbs.push(fn)
  this._deliveryCallbacks.put(idx, cbs)
}

Connection.prototype._callDeliveryCallbacks = function (idx) {
  var cbs = this._deliveryCallbacks.get(idx)
  if (!cbs) return

  var l = cbs.length
  var callNow = []
  var callLater = []
  for (var i = 0; i < l; i++) {
    var fn = cbs[i]
    fn._sendyRoundsLeft--
    if (fn._sendyRoundsLeft <= 0) {
      callNow.push(fn)
    } else {
      callLater.push(fn)
    }
  }

  if (callLater.length === 0) this._deliveryCallbacks.del(idx)
  else this._deliveryCallbacks.put(callLater)

  if (!callNow.length) return

  process.nextTick(function () {
    callNow.forEach(call)
  })
}

Connection.prototype._flush = function () {
  if (this._connecting || this._paused || !this._writeBuffer.length || !this._writable()) return

  var length = 0
  var data = this._writeBuffer.shift()
  while (length < this._mtu && this._writeBuffer.length) {
    data = Buffer.concat([data, this._writeBuffer.shift()])
  }

  while (this._writable()) {
    var payload = this._payload(data)

    this._sendOutgoing(createPacket(this, PACKET_DATA, payload))

    if (payload.length === data.length) return this._flush()
    data = data.slice(payload.length)
  }

  this._writeBuffer.unshift(data)
}

Connection.prototype._bufferData = function (data) {
  this._writeBuffer.push(data)
}

Connection.prototype._writable = function () {
  // !this._connecting && !this._paused &&
  return this._inflightPackets < BUFFER_SIZE - 1
}

Connection.prototype._payload = function (data) {
  if (data.length > this._mtu) return data.slice(0, this._mtu)
  return data
}

// Connection.prototype._countRequiredPackets = function (data) {
//   return Math.ceil(data.length / this._mtu)
// }

Connection.prototype._resend = function () {
  if (this._paused || !this._inflightPackets) return

  var offset = this._seq - this._inflightPackets
  var first = this._outgoing.get(offset)
  if (!first) return

  var timeout = 500000
  var now = timestamp()

  if (uint32(first.sent - now) < timeout) return

  for (var i = 0; i < this._inflightPackets; i++) {
    var packet = this._outgoing.get(offset + i)
    // this._debug('resending ' + packetType(packet))
    if (uint32(packet.sent - now) >= timeout) this._transmit(packet)
  }
}

Connection.prototype._keepAlive = function () {
  if (this._paused) return
  if (this._alive) return this._alive = false
  this._sendAck()
}

Connection.prototype._recvAck = function (ack) {
  var offset = this._seq - this._inflightPackets
  var acked = uint16(ack - offset) + 1

  if (acked >= BUFFER_SIZE) return // sanity check

  var callbacks = []
  for (var i = 0; i < acked; i++) {
    var seq = offset + i
    var packet = this._outgoing.del(seq)
    this._callDeliveryCallbacks(seq)
    if (packet) {
      this._inflightPackets--
    }
    // else {
    //   console.log(this._id, 'boo', seq)
    // }
  }

  if (!this._inflightPackets) {
    this.emit('flush')
  } else {
    // this._writable() may now be true
    this._flush()
  }
}

// Connection.prototype.reset = function (err) {
//   this._cancelPending(err)
//   this._reset() // don't resend
// }

Connection.prototype._cancelPending = function (err) {
  err = err || new Error('connection was reset')
  var cbArrays = this._deliveryCallbacks.values.slice()
  this._deliveryCallbacks = cyclist(BUFFER_SIZE)

  cbArrays.forEach(function (arr) {
    if (arr) {
      arr.forEach(function (fn) {
        fn(err)
      })
    }
  })
}

Connection.prototype._resetTimeout = function () {
  this._lastReceivedTimestamp = Date.now()
  if ('_idleTimeout' in this) {
    this.setTimeout(this._idleTimeoutMillis)
  }
}

Connection.prototype.idleTime = function () {
  return Date.now() - (this._lastReceivedTimestamp || 0)
}

Connection.prototype.receive = function (packet) {
  this._resetTimeout()
  // this._debug('received ' + packetType(packet), ', connection:', packet.connection)
  if (packet.id === PACKET_SYN) {
    if (this._initiator) {
      return this._transmit(createPacket(this, PACKET_RESET))
    }

    this._sendAck()
    return;
  }

  if (packet.id === PACKET_RESET) {
    this._debug('received RESET')
    this.close()
    return
  }

  if (this._connecting) {
    if (packet.id !== PACKET_STATE) return //this._incoming.put(packet.seq, packet)

    this._ack = uint16(packet.seq-1)
    this._recvAck(packet.ack)
    this._onconnected()

    packet = this._incoming.del(packet.seq)
    if (!packet) return
  }

  this._recvAck(packet.ack)
  if (packet.id === PACKET_STATE) return

  var place = uint16(packet.seq - this._ack)
  if (!place || place >= BUFFER_SIZE) {
    return this._sendAck() // old packet
  }

  this._incoming.put(packet.seq, packet)
  while (packet = this._incoming.del(this._ack + 1)) {
    this._ack = uint16(this._ack + 1)
    if (packet.id === PACKET_DATA) {
      this.emit('receive', packet.data)
    }

    if (packet.id === PACKET_FIN) {
      this._debug('received FIN')
      return this.close()
    }
  }

  this._sendAck()
}

Connection.prototype._sendAck = function () {
  this._transmit(createPacket(this, PACKET_STATE, null)); // TODO: make this delayed
}

Connection.prototype._sendOutgoing = function (packet) {
  this._outgoing.put(packet.seq, packet)
  this._seq = uint16(this._seq + 1)
  this._inflightPackets++
  this._transmit(packet)
}

// Connection.prototype._cancelPacket = function (packet) {
//   var outgoing = this._outgoing.get(packet.seq)
//   if (outgoing === packet) {
//     this._outgoing.del(packet.seq)
//     this._inflightPackets--
//   }
// }

Connection.prototype._transmit = function (packet) {
  packet.sent = packet.sent === 0 ? packet.timestamp : timestamp()
  var message = packetToBuffer(packet)
  this._alive = true
  // this._debug('sending ' + packetType(packet), 'seq:', packet.seq, ', ack:', packet.ack, ', connection:', packet.connection)
  this.emit('send', message)
}

Connection.prototype.pause = function () {
  if (this._paused) return
  this._paused = true
  this.emit('pause')
}

Connection.prototype.resume = function () {
  if (!this._paused) return
  this._paused = false
  this.emit('resume')
}

Connection.prototype.isPaused = function () {
  return this._paused
}

function Server (opts) {
  if (!(this instanceof Server)) return new Server(opts)

  EventEmitter.call(this)
  this._connections = {}
  this._opts = opts
}

util.inherits(Server, EventEmitter)

Server.prototype.receive = function (message) {
  if (message.length < MIN_PACKET_SIZE) return

  var packet = Buffer.isBuffer(message) ? bufferToPacket(message) : message
  if (this._closed && packet.id !== PACKET_FIN && packet.id !== PACKET_STATE) {
    return
  }

  var connections = this._connections
  var id = packet.id === PACKET_SYN ? uint16(packet.connection+1) : packet.connection
  var conn = connections[id]
  if (conn) return conn.receive(packet)
  if (packet.id !== PACKET_SYN) {
    if (packet.id !== PACKET_RESET) {
      // we don't know whether we were the initiator
      // of this lost connection, so send 2 reset packets
      // if we were the initiator, our sendId = packet.connection + 1
      // if we were the receiver, our sendId = packet.connection
      this._debug('received packet from non-existent connection, sending reset')
      ;[packet.connection, packet.connection + 1].forEach(function (sendId) {
        var reset = createPacket({
          _sendId: sendId,
          seq: 0,
          ack: 0
        }, PACKET_RESET)

        this.emit('send', packetToBuffer(reset))
      }, this)
    }

    return
  }

  conn = connections[id] = new Connection(this._opts, packet)
  if (this._timeoutMillis) {
    conn.setTimeout(this._timeoutMillis)
  }

  conn.once('close', function() {
    delete connections[id]
  })

  this.emit('connection', conn)
  reemit(conn, this, ['send', 'receive'])
}

Server.prototype._debug = function () {
  var args = [].slice.call(arguments)
  args.unshift('server')
  return debug(args.join(' '))
}

// Server.prototype._reset = function (resend) {
//   for (var id in this._connections) {
//     this._connections[id].destroy(resend)
//   }
// }

Server.prototype.close =
Server.prototype.destroy = function () {
  if (this._closed) return

  this._closed = true
  this.connections().forEach(function (c) {
    c.close()
  })

  this._debug('closing')
  this.emit('close')
}

Server.prototype.setTimeout = function (millis) {
  this._timeoutMillis = millis
  for (var id in this._connections) {
    this._connections[id].setTimeout(millis)
  }
}

Server.prototype.clearTimeout = function () {
  delete this._timeoutMillis
  for (var id in this._connections) {
    this._connections[id].clearTimeout()
  }
}

Server.prototype.connections = function () {
  return Object.keys(this._connections).map(function (cid) {
    return this._connections[cid]
  }, this)
}

function SymmetricClient (opts) {
  EventEmitter.call(this)
  this._opts = opts || {}
  this._reset()
}

util.inherits(SymmetricClient, EventEmitter)

SymmetricClient.prototype._reset = function (resend) {
  var inbound = this._inbound
  if (inbound) {
    this._debug('resetting symmetric client')
    inbound.close()
    inbound.removeAllListeners()
  }

  var outbound = this._outbound
  if (this._dedicatedOutbound) {
    outbound.close()
    outbound.removeAllListeners()
  }

  this._inbound = new Server(this._opts)
  reemit(this._inbound, this, ['send', 'receive', 'connection'])

  if (resend) {
    this._resendPending()
  } else {
    this._pending = []
    if (this._opts.autoConnect !== false) {
      this._createOutboundConnection()
    }
  }
}

SymmetricClient.prototype._resendPending = function () {
  var pending = this._pending && this._pending.slice()
  this._pending = []
  if (pending) {
    pending.forEach(function (args) {
      this.send.apply(this, args)
    }, this)
  }
}

SymmetricClient.prototype._createOutboundConnection = function () {
  var self = this

  this._dedicatedOutbound = true
  // TODO: reuse existing inbound connection if possible

  this._outbound = new Connection(this._opts)
  this._outbound.once('close', function () {
    if (self._closed) return

    self._createOutboundConnection()
    if (!self._pending.length) return

    self._debug('resending pending')
    self._resendPending()
  })

  reemit(this._outbound, this, ['send', 'receive', 'timeout', 'pause', 'resume'])
  if (this._timeoutMillis) {
    this._outbound.setTimeout(this._timeoutMillis)
  }
}

SymmetricClient.prototype.receive = function (message) {
  var packet = bufferToPacket(message)
  var isForOutbound
  if (this._outbound) {
    isForOutbound = (
      packet.connection === this._outbound._recvId ||
      // see rationale in server.receive
      (packet.id === PACKET_RESET && packet.connection === this._outbound._sendId)
    )
  }

  if (isForOutbound) {
    this._outbound.receive(packet)
  } else {
    this._inbound.receive(packet)
  }
}

SymmetricClient.prototype.send = function (message, ondelivered) {
  var self = this
  ondelivered = ondelivered || noop

  if (!this._outbound) {
    // TODO: reuse inbound connection, if exists
    // get freshest connection
    // this._outbound = this._inbound.connections().sort(decreasingFreshness)[0]
    // if (this._outbound) {
    //   this._dedicatedOutbound = false
    //   reemit(this._outbound, this, ['timeout', 'pause', 'resume'])
    //   this._debug('reusing existing inbound connection for outbound')
    // } else {
      this._createOutboundConnection()
    // }
  }

  this._pending.push([message, ondelivered])
  this._outbound.send(message, function (err) {
    if (self._closed) return

    self._pending.shift()
    if (err) {
      // requeue
      process.nextTick(function () {
        self.send(message, ondelivered)
      })
    } else {
      ondelivered(err)
    }
  })
}

SymmetricClient.prototype.close =
SymmetricClient.prototype.destroy = function () {
  if (this._closed) return

  this._debug('closing')
  this._closed = true
  this._inbound.close()
  if (this._dedicatedOutbound) {
    this._outbound.close()
  }
}

SymmetricClient.prototype.setTimeout = function (millis) {
  this._timeoutMillis = millis
  this._inbound.setTimeout(millis)
  if (this._outbound) {
    this._outbound.setTimeout(millis)
  }
}

SymmetricClient.prototype.clearTimeout = function () {
  this._inbound.clearTimeout()
  if (this._outbound) {
    this._outbound.clearTimeout()
  }
}

SymmetricClient.prototype.pause = function () {
  if (this._outbound) {
    this._outbound.pause()
  }
}

SymmetricClient.prototype.resume = function () {
  if (this._outbound) {
    this._outbound.resume()
  }
}

SymmetricClient.prototype.isPaused = function () {
  if (this._outbound) {
    return this._outbound.isPaused()
  }
}

SymmetricClient.prototype.outboundConnection = function () {
  return this._outbound
}

SymmetricClient.prototype.inboundConnections = function () {
  return this._inbound.connections()
}

SymmetricClient.prototype._debug = function () {
  var args = [].slice.call(arguments)
  args.unshift('manager')
  return debug(args.join(' '))
}

exports = module.exports = SymmetricClient
exports.Connection = Connection
exports.Server = Server
exports.createServer = Server
exports.packetToBuffer = packetToBuffer
exports.bufferToPacket = bufferToPacket
// exports.CONNECTIONS = CONNECTIONS

function call (fn) {
  fn()
}

function decreasingFreshness (a, b) {
  return a.idleTime() - b.idleTime()
}

// function oneTickClose (emitter, cb) {
//   cb = cb || noop

//   if (emitter._closed) return process.nextTick(cb)

//   emitter.once('close', cb)
//   if (emitter._closing) return

//   emitter._closing = true
//   process.nextTick(function () {
//     emitter._closed = true
//     emitter.emit('close')
//   })

//   return true
// }
