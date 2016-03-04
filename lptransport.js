var EventEmitter = require('events').EventEmitter
var util = require('util')
var varint = require('varint')
var lps = require('length-prefixed-stream')
var utils = require('./utils')
var UINT32 = 0xffffffff

function LengthPrefixed (opts) {
  var self = this

  if (!opts.connection) throw new Error('expected option "connection"')

  EventEmitter.call(this)

  this._connection = opts.connection
  this._connection.once('destroy', function () {
    self._destroyed = true
    self._connection = null
  })

  this._queued = 0
  this._deliveryCallbacks = {}

  var decoder = lps.decode()
  this._connection.on('message', function (lengthPrefixedData) {
    decoder.write(lengthPrefixedData)
  })

  decoder.on('data', function (data) {
    self.emit('message', data)
  })

  var id = 0
  Object.defineProperty(this, '_nextCallbackId', {
    get: function () {
      return '' + (id++ & UINT32)
    }
  })
}

util.inherits(LengthPrefixed, EventEmitter)
exports = module.exports = LengthPrefixed

LengthPrefixed.prototype.send = function (msg, cb) {
  var self = this

  this._deliveryCallbacks[this._nextCallbackId] = {
    count: ++this._queued,
    callback: cb
  }

  var data = utils.toBuffer(msg)
  var length = new Buffer(varint.encode(data.length))
  var totalLength = data.length + length.length

  this._connection.send(Buffer.concat([length, data], totalLength), function () {
    self._queued--
    for (var id in self._deliveryCallbacks) {
      var waiter = self._deliveryCallbacks[id]
      if (--waiter.count === 0) {
        delete self._deliveryCallbacks[id]
        waiter.callback()
      }
    }
  })
}

LengthPrefixed.prototype.destroy = function () {
  if (this._connection) {
    this._connection.destroy()
    // nulled in 'destroy' handler too
    // but this prevents subsequent destroy calls
    this._connection = null
  }
}
