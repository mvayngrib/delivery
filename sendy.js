var EventEmitter = require('events').EventEmitter
var util = require('util')
var varint = require('varint')
var lps = require('length-prefixed-stream')
var utils = require('./utils')
var Connection = require('./connection')
var UINT32 = 0xffffffff

function LengthPrefixed (opts) {
  var self = this

  opts = opts || {}

  EventEmitter.call(this)

  this._connection = opts.connection || new Connection(opts)
  utils.connect(this, this._connection)
  this._connection.once('destroy', function () {
    self._destroyed = true
    self._connection = null
  })

  this._queued = 0
  this._deliveryCallbacks = []

  this._decoder = lps.decode()
  this._connection.on('receive', function (lengthPrefixedData) {
    self._decoder.write(lengthPrefixedData)
  })

  this._decoder.on('data', function (data) {
    self.emit('receive', data)
  })
}

util.inherits(LengthPrefixed, EventEmitter)
exports = module.exports = LengthPrefixed

LengthPrefixed.prototype.send = function (msg, cb) {
  var self = this

  if (cb) {
    this._deliveryCallbacks.push({
      count: ++this._queued,
      callback: cb
    })
  }

  var data = utils.toBuffer(msg)
  var length = new Buffer(varint.encode(data.length))
  var totalLength = data.length + length.length

  this._connection.send(Buffer.concat([length, data], totalLength), function () {
    self._queued--
    self._deliveryCallbacks = self._deliveryCallbacks.filter(function (item) {
      if (--item.count === 0) {
        var cb = item.callback
        if (cb) cb()

        return
      }

      return true
    })
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
