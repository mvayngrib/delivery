var EventEmitter = require('events').EventEmitter
var util = require('util')
var varint = require('varint')
var lps = require('length-prefixed-stream')
var debug = require('debug')('sendy-messenger')
var once = require('once')
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
    process.nextTick(function () {
      self._decoder.write(lengthPrefixedData)
    })
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

// LengthPrefixed.prototype.reset = function (err) {
//   if (this._destroyed) return

//   var cbs = err && this._deliveryCallbacks && this._deliveryCallbacks.slice()
//   this._queued = 0
//   this._deliveryCallbacks = []
//   this._resetDecoder()
//   this._client.reset(err)
// }

LengthPrefixed.prototype.send = function (msg, cb) {
  var self = this

  if (this._cancelingPending) {
    return process.nextTick(function () {
      self.send(msg, cb)
    })
  }

  cb = once(cb || function () {})
  cb[COUNT_PROP] = ++this._queued
  this._deliveryCallbacks.push(cb)

  var data = utils.toBuffer(msg)
  var length = new Buffer(varint.encode(data.length))
  var totalLength = data.length + length.length

  this._client.send(Buffer.concat([length, data], totalLength), function (err) {
    if (err) {
      // less efficient but simpler
      return self.destroy(err)
      // // cancel all queued
      // self._cancelingPending = true
      // process.nextTick(function () {
      //   self._cancelingPending = false
      // })

      // var cbs = self._deliveryCallbacks.slice()
      // self._deliveryCallbacks.length = 0
      // self._queued = 0
      // cbs.forEach(function (fn) {
      //   fn(err)
      // })

      // return
    }

    self._queued--
    self._deliveryCallbacks.forEach(function (cb) {
      cb[COUNT_PROP]--
    })

    var callNow = self._deliveryCallbacks.filter(function (cb) {
      return cb[COUNT_PROP] === 0
    })

    self._deliveryCallbacks = self._deliveryCallbacks.filter(function (cb) {
      return cb[COUNT_PROP] !== 0
    })

    callNow.forEach(function (cb) {
      cb()
    })
  })
}

LengthPrefixed.prototype.destroy = function () {
  if (this._destroyed) return

  this._destroyed = true
  this._client.destroy()
  if (this._deliveryCallbacks.length) {
    var err = new Error('destroyed')
    var cbs = this._deliveryCallbacks
    cbs.forEach(function (fn) {
      fn(err)
    })
  }

  this.emit('destroy', err)
}
