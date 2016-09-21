var cyclist = require('cyclist')
var util = require('util')
var EventEmitter = require('events').EventEmitter
var debug = require('debug')('sendy-connection')
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

var CID = 0
var Connection = function (options) {
  var self = this
  options = options || {}

  this._mtu = options.mtu || MTU
  var resendInterval = options.resendInterval || RESEND_INTERVAL
  var keepAliveInterval = options.keepAliveInterval || KEEP_ALIVE_INTERVAL

  EventEmitter.call(this)

  this.setMaxListeners(0)
  this._id = CID++
  this._reset()

  var resend = setInterval(this._resend.bind(this), resendInterval)
  var keepAlive = setInterval(this._keepAlive.bind(this), keepAliveInterval)

  this.once('destroy', function () {
    self._debug('destroyed')
    clearInterval(resend)
    clearInterval(keepAlive)
    self.clearTimeout()
    self._cancelPending()
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
}

Connection.MTU = MTU
util.inherits(Connection, EventEmitter)

Connection.prototype._onconnected = function () {
  this._connecting = false
  this.emit('connect')
}

Connection.prototype._debug = function () {
  var args = [].slice.call(arguments)
  args.unshift(this._id)
  return debug(args.join(' '))
}

Connection.prototype.setTimeout = function(millis, cb) {
  var self = this

  this.clearTimeout()
  if (!millis) return

  this._idleTimeoutMillis = millis
  this._idleTimeout = setTimeout(function () {
    self.clearTimeout()
    self.emit('timeout', millis)
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
}

Connection.prototype._sendSyn = function () {
  if (this._syn) return this._transmit(this._syn)

  this._recvId = nonRepeatRandom()
  this._sendId = uint16(this._recvId + 1)
  this._connId = this._recvId
  this._syn = createPacket(this, PACKET_SYN, null)
  this._sendOutgoing(this._syn)
}

Connection.prototype.send = function (data, ondelivered) {
  var self = this
  if (this._destroyed) return
  if (!this._recvId) this._sendSyn()

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

Connection.prototype._reset = function (resend) {
  var self = this

  this._debug('reset, resend: ' + (!!resend))
  if (this._msgQueue) {
    this._debug('resetting')
    this.emit('reset')
  }

  var msgs = resend && this._msgQueue && this._msgQueue.slice()

  this._paused = false
  this._msgQueue = []
  this._writeBuffer = []
  this._deliveryCallbacks = cyclist(BUFFER_SIZE)
  this._outgoing = cyclist(BUFFER_SIZE)
  this._incoming = cyclist(BUFFER_SIZE)

  this._inflightPackets = 0
  this._alive = false

  this._connecting = true
  this._connId = null
  this._recvId = null // tmp value for v8 opt
  this._sendId = null // tmp value for v8 opt
  this._ack = null
  // this._old = 0 // num old packets received in a row
  this._seq = this._id ? 105 : 372 //(Math.random() * UINT16) | 0
  this._syn = null
  this._theirSyn = null
  // this._backedUp = 0
  // this._synack = null

  if (!resend) return

  if (msgs && msgs.length) {
    msgs.forEach(function (args) {
      this.send.apply(this, args)
    }, this)
  } else {
    // other party expects a SYN from us
    this._sendSyn()
  }
}

Connection.prototype._resetTimeout = function () {
  this._lastReceivedTimestamp = Date.now()
  if ('_idleTimeout' in this) {
    this.setTimeout(this._idleTimeoutMillis)
  }
}

Connection.prototype._millisSinceLastReceived = function () {
  return Date.now() - (this._lastReceivedTimestamp || 0)
}

Connection.prototype._finishConnecting = function (packet) {
  if (packet.id === PACKET_SYN) {
    if (this._theirSyn && this._theirSyn.connection === packet.connection) {
      return this._sendAck()
    }

    // our conn id should win
    // ignore their syn and keep resending ours
    if (this._syn && this._recvId > packet.connection) {
      this._debug('our conn wins')
      return
    }

    if (this._recvId === packet.connection) {
      this._debug('resetting due to connection id collision')
      this._reset(true)
      // this._sendAck()
      return
    }

    // their conn id won
    this._debug('their conn wins')
    var msgs
    if (this._syn) {
      msgs = this._msgQueue.slice()
      this._reset()
      // this._cancelPacket(this._syn)
    }

    this._recvId = uint16(packet.connection + 1)
    this._sendId = packet.connection
    this._connId = this._sendId
    this._ack = uint16(packet.seq)
    this._theirSyn = packet
    this._syn = null
    this._sendAck()
    if (msgs) {
      // debugger
      msgs.forEach(function (args) {
        this.send.apply(this, args)
      }, this)
    }

    return
  }

  if (!this._recvId) {
    // this._debug('expected SYN, got ' + packetType(packet) + ', sending own SYN')
    this._debug('expected SYN, got ' + packetType(packet) + ', sending RESET')
    return this._transmit(createPacket(this, PACKET_RESET))
    // return this._sendSyn()
  }

  if (!this._isPacketForThisConnection(packet)) {
    this._debug('1. ignoring ' + packetType(packet) + ' with a different connection id', this._recvId, packet.connection)
    return
  }

  var isInitiator = this._sendId > this._recvId
  if (!isInitiator) {
    if (this._ack === null) {
      this._ack = packet.seq - 1
    }

    return this._onconnected()
  }

  if (packet.id === PACKET_STATE) {
    var ackedPacket = this._outgoing.get(packet.ack)
    if (!ackedPacket || ackedPacket.id !== PACKET_SYN) return

    this._ack = uint16(packet.seq - 1)
    this._recvAck(packet.ack)
    // this._sendAck()
    // this._incoming.del(packet.seq)
    return this._onconnected()
  }
}

Connection.prototype._isPacketForThisConnection = function (packet) {
  if (packet.id === PACKET_SYN) {
    return this._theirSyn && packet.connection === this._theirSyn.connection
  }

  return packet.connection === this._recvId
}

Connection.prototype.receive = function (buffer) {
  var self = this
  if (this._destroyed) {
    this._debug('cannot receive, am destroyed')
    return
  }

  // we might be paused
  this.resume()

  var packet = Buffer.isBuffer(buffer) ? bufferToPacket(buffer) : buffer
  // this._debug('connected: ' + (!this._connecting) + '\n    received: ' + packetType(packet) + '\n    with seq: ' + packet.seq + '\n    and ack: ' + packet.ack)

  if (packet.id === PACKET_RESET) {
    this._debug('resetting due to received RESET packet')
    return this._reset(true)
  // return this.destroy()
  }

  if (this._connecting) {
    this._resetTimeout()
    this._finishConnecting(packet)
    if (this._connecting) return
  }

  if (packet.id === PACKET_SYN) {
    if (packet.connection !== this._connId) {
      this._debug('resetting due to new SYN received')
      // var queued = this._msgQueue.slice()
      this._reset(true)
      return this.receive(packet)
      // return queued.forEach(function (args) {
      //   self.send.apply(self, args)
      // })
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

  if (!this._isPacketForThisConnection(packet)) {
    this._debug('2. ignoring ' + packetType(packet) + ' with a different connection id')
    return
  }

  this._resetTimeout()
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
      return this.destroy()
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
  // this._debug('sending ' + packetType(packet), packet.seq, ', acking ' + packet.ack)
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

exports.packetToBuffer = packetToBuffer
exports.bufferToPacket = bufferToPacket
exports.Connection = module.exports = Connection

function call (fn) {
  fn()
}
