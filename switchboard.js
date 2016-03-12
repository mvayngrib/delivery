
var util = require('util')
var EventEmitter = require('events').EventEmitter
var typeforce = require('typeforce')
var extend = require('xtend/mutable')
var debug = require('debug')('sendy-switchboard')
var Sendy = require('./sendy')
var nochange = function (data) {
  return data
}

var DEFAULT_CLIENT_MAKER = function () {
  return new Sendy()
}

function Switchboard (opts) {
  var self = this
  if (!(this instanceof Switchboard)) return new Switchboard(opts)

  typeforce({
    unreliable: 'Object',
    clientForRecipient: '?Function',
    encode: '?Function',
    decode: '?Function'
  }, opts)

  EventEmitter.call(this)

  this._encode = opts.encode || nochange
  this._decode = opts.decode || nochange
  this._url = opts.url
  this._clientForRecipient = opts.clientForRecipient || DEFAULT_CLIENT_MAKER
  this._rclients = {}
  this._queued = {}

  this._uclient = opts.unreliable
  this._uclient.on('receive', function (msg) {
    msg = self._decode(msg)
    var rclient = self._getReliableClientFor(msg.from)
    if (rclient) {
      // debug('received msg from ' + msg.from + ', length: ' + msg.data.length)
      self.emit('receiving', msg)
      rclient.receive(msg.data)
    }
  })

  this._uclient.on('disconnect', function () {
    for (var id in self._rclients) {
      var rclient = self._rclients[id]
      if (rclient.pause) rclient.pause()
    }
  })

  this._uclient.on('connect', function () {
    for (var id in self._rclients) {
      var rclient = self._rclients[id]
      if (rclient.resume) rclient.resume()
    }
  })
}

util.inherits(Switchboard, EventEmitter)
exports = module.exports = Switchboard
var proto = Switchboard.prototype

proto.send = function (recipient, msg, ondelivered) {
  debug('queueing msg to ' + recipient)
  var rclient = this._getReliableClientFor(recipient)
  if (!rclient) return

  var queue = this._queued[recipient]
  if (!queue) queue = this._queued[recipient] = []

  var done
  var cbWrapper = function (err) {
    if (done) return

    done = true
    // queue.splice(queue.indexOf(job), 1)
    queue.shift() // rclient delivers in order
    if (ondelivered) ondelivered(err)
  }

  queue.push([msg, cbWrapper])
  rclient.send(msg, cbWrapper)
}

proto.cancelPending = function (recipient) {
  var err = new Error('canceled')
  for (var id in this._rclients) {
    if (!recipient || id === recipient) {
      this._rclients[id].destroy()
    }
  }
}

proto.clients = function () {
  return Object.keys(this._rclients).map(function (k) {
    return this._rclients[k]
  }, this)
}

proto._getReliableClientFor = function (recipient) {
  var self = this
  var rclient = this._rclients[recipient]
  if (rclient) return rclient

  rclient = this._rclients[recipient] = this._clientForRecipient(recipient)
  if (!rclient) return

  rclient.on('receive', function (msg) {
    // emit message from whoever `recipient` is
    // debug('bubbling received msg from ' + recipient + ', length: ' + msg.length)
    self.emit('message', msg, recipient)
  })

  rclient.on('send', function (msg) {
    // debug('sending msg to ' + recipient + ', length: ' + msg.length)
    msg = self._encode(msg, recipient)
    self._uclient.send(msg)
  })

  rclient.on('destroy', function () {
    delete self._rclients[recipient]
    var queue = self._queued[recipient]
    if (!queue) return

    var err = new Error('connection destroyed')
    delete self._queued[recipient]
    for (var i = 0; i < queue.length; i++) {
      debugger
      queue[i][1](err)
    }
  })

  return rclient
}

proto.destroy = function () {
  for (var recipient in this._rclients) {
    this._rclients[recipient].destroy()
  }

  this._uclient.destroy()
  delete this._reliabilityClient
  delete this._wsClient
}

;['pause', 'resume'].forEach(function (method) {
  proto[method] = function (recipient) {
    for (var id in this._rclients) {
      if (!recipient || id === recipient) {
        var rclient = this._rclients[id]
        rclient[method]()
      }
    }
  }
})
