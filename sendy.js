var EventEmitter = require('events').EventEmitter
var util = require('util')
var varint = require('varint')
var lps = require('length-prefixed-stream')
var debug = require('debug')('sendy')
var utils = require('./utils')
var Connection = require('./connection')
var UINT32 = 0xffffffff
var COUNT_PROP = '_sendyCount'

function LengthPrefixed (opts) {
  var self = this

  opts = opts || {}

  EventEmitter.call(this)

  this._client = opts.client || new Connection(opts)
  utils.connect(this, this._client)

  this._client.once('destroy', function () {
    self._destroyed = true
    self._client = null
  })

  this._client.on('reset', function () {
    debug('reset length-prefixed decoder')
    self._resetDecoder()
  })

  this._client.on('receive', function (lengthPrefixedData) {
    self._decoder.write(lengthPrefixedData)
  })

  this._onDecoded = this._onDecoded.bind(this)
  this._queued = 0
  this._deliveryCallbacks = []
  this._resetDecoder()
}

util.inherits(LengthPrefixed, EventEmitter)
exports = module.exports = LengthPrefixed

LengthPrefixed.prototype._resetDecoder = function () {
  if (this._decoder) {
    this._decoder.removeListener('data', this._onDecoded)
  }

  this._decoder = lps.decode()
  this._decoder.on('data', this._onDecoded)
}

LengthPrefixed.prototype._onDecoded = function (data) {
  this.emit('receive', data)
}

LengthPrefixed.prototype.reset = function (abortPending) {
  if (this._destroyed) return

  var cbs = this._deliveryCallbacks && this._deliveryCallbacks.slice()
  this._queued = 0
  this._deliveryCallbacks = []
  this._resetDecoder()
  this._client.reset()
  if (abortPending && cbs) {
    var err = new Error('aborted')
    cbs.forEach(function (fn) {
      fn(err)
    })
  }
}

LengthPrefixed.prototype.send = function (msg, cb) {
  var self = this

  if (cb) {
    cb[COUNT_PROP] = ++this._queued
    this._deliveryCallbacks.push(cb)
  }

  var data = utils.toBuffer(msg)
  var length = new Buffer(varint.encode(data.length))
  var totalLength = data.length + length.length

  this._client.send(Buffer.concat([length, data], totalLength), function () {
    self._queued--
    self._deliveryCallbacks = self._deliveryCallbacks.filter(function (cb) {
      if (--cb[COUNT_PROP] === 0) {
        cb()
        return false
      }

      return true
    })
  })
}

LengthPrefixed.prototype.destroy = function () {
  if (this._client) {
    this._client.destroy()
    // nulled in 'destroy' handler too
    // but this prevents subsequent destroy calls
    this._client = null
    this.emit('destroy')
  }
}
