
var util = require('util')
var EventEmitter = require('events').EventEmitter
var typeforce = require('typeforce')
var extend = require('xtend/mutable')
var bindAll = require('bindall')
var once = require('once')
var debug = require('debug')('sendy-switchboard')
var Sendy = require('./sendy')
var noop = function () {}
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
    decode: '?Function',
    sendTimeout: '?Number'
  }, opts)

  EventEmitter.call(this)

  bindAll(this)

  this._encode = opts.encode || nochange
  this._decode = opts.decode || nochange
  this._url = opts.url
  this._clientForRecipient = opts.clientForRecipient || DEFAULT_CLIENT_MAKER
  this._rclients = {}
  this._queued = {}
  this._sendTimeout = opts.sendTimeout

  this._uclient = opts.unreliable
  this._uclient.on('receive', function (msg) {
    if (self._destroyed) return

    msg = self._decode(msg)
    var rclient = self._getReliableClientFor(msg.from)
    if (rclient) {
      // debug('received msg from ' + msg.from + ', length: ' + msg.data.length)
      self.emit('receiving', msg)
      rclient.receive(msg.data)
    }
  })

  this._uclient.on('disconnect', function () {
    if (self._destroyed) return

    for (var id in self._rclients) {
      var rclient = self._rclients[id]
      if (rclient.pause) rclient.pause()
    }
  })

  this._uclient.on('connect', function () {
    if (self._destroyed) return

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
  var self = this

  if (this._cancelingPending) {
    return process.nextTick(function () {
      self.send(recipient, msg, ondelivered)
    })
  }

  debug('queueing msg to ' + recipient)
  var rclient = this._getReliableClientFor(recipient)
  if (!rclient) return

  ondelivered = once(ondelivered || noop)

  var queue = this._queued[recipient]
  if (!queue) queue = this._queued[recipient] = []

  var done
  var timeout
  queue.push({
    msg: msg,
    callback: ondelivered
  })

  rclient.send(msg, function (err) {
    clearTimeout(timeout)
    if (done) return

    done = true
    if (!err) {
      var item = queue.shift() // rclient delivers in order
      if (item.callback) item.callback()

      return
    }

    // pause operations
    self._cancelingPending = true
    process.nextTick(function () {
      self._cancelingPending = false
    })

    // as we're in the business of in-order delivery
    // all the queued messages should be failed
    // so whoever's running this operation can requeue them
    var tmp = queue.slice()
    queue.length = 0
    tmp.forEach(function (item) {
      item.callback(err)
    })
  })

  // if (!this._sendTimeout) return

  // timeout = setTimeout(function () {
  //   cbWrapper(new Error('timed out'))
  // }, self._sendTimeout)
}

proto.clearTimeout = function () {
  this._proxyMethod('clearTimeout', arguments)
}

proto.setTimeout = function (millis) {
  this._sendTimeout = millis
  this._proxyMethod('setTimeout', arguments)
}

proto.cancelPending = function (recipient) {
  var err = new Error('canceled')
  for (var id in this._rclients) {
    if (!recipient || id === recipient) {
      if (this._queued[id] && this._queued[id].length) {
        // queues get cleaned up in 'destroy' handler
        this._rclients[id].destroy()
        // this._rclients[id].reset(err)
      }
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

  if (this._sendTimeout) {
    rclient.setTimeout(this._sendTimeout)
  }

  rclient.on('timeout', function () {
    if (self._destroyed) return

    self.emit('timeout', recipient)
  }),

  rclient.on('receive', function (msg) {
    if (self._destroyed) return

    // emit message from whoever `recipient` is
    // debug('bubbling received msg from ' + recipient + ', length: ' + msg.length)
    self.emit('message', msg, recipient)
  }),

  rclient.on('send', function (msg) {
    if (self._destroyed) return

    // debug('sending msg to ' + recipient + ', length: ' + msg.length)
    msg = self._encode(msg, recipient)
    self._uclient.send(msg)
  }),

  rclient.on('destroy', function (err) {
    // cleanup.forEach(call)

    delete self._rclients[recipient]
    var queue = self._queued[recipient]
    if (!queue || !queue.length) return

    err = err || new Error('connection was destroyed')
    delete self._queued[recipient]
    for (var i = 0; i < queue.length; i++) {
      queue[i].callback(err)
    }
  })

  return rclient
}

proto._proxyMethod = function (method, args) {
  for (var id in this._rclients) {
    var c = this._rclients[id]
    c[method].apply(c, args)
  }
}

proto.destroy = function () {
  if (this._destroyed) return

  this._destroyed = true

  for (var recipient in this._rclients) {
    this._rclients[recipient].destroy()
  }

  this._uclient.destroy()
  delete this._reliabilityClient
  delete this._uclient
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

// function listen (emitter, event, handler) {
//   emitter.on(event, handler)
//   return function () {
//     emitter.removeListener(event, handler)
//   }
// }

// function call (fn) {
//   fn()
// }
