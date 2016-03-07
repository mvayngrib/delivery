
var util = require('util')
var EventEmitter = require('events').EventEmitter
var typeforce = require('typeforce')
var extend = require('xtend/mutable')
var nochange = function (data) {
  return data
}

function Switchboard (opts) {
  var self = this

  typeforce({
    unreliable: 'Object',
    clientForRecipient: 'Function',
    encode: '?Function',
    decode: '?Function'
  }, opts)

  EventEmitter.call(this)

  this._encode = opts.encode || nochange
  this._decode = opts.decode || nochange
  this._url = opts.url
  this._clientForRecipient = opts.clientForRecipient
  this._rclients = {}

  this._uclient = opts.unreliable
  this._uclient.on('receive', function (msg) {
    msg = self._decode(msg)
    var rclient = self._getReliableClientFor(msg.from)
    if (rclient) {
      rclient.receive(msg.data)
    }
  })
}

util.inherits(Switchboard, EventEmitter)
exports = module.exports = Switchboard
var proto = Switchboard.prototype

proto.send = function (recipient, msg, ondelivered) {
  var rclient = this._getReliableClientFor(recipient)
  if (rclient) {
    rclient.send(msg, ondelivered)
  }
}

proto._getReliableClientFor = function (recipient) {
  var self = this
  var rclient = this._rclients[recipient]
  if (rclient) return rclient

  rclient = this._rclients[recipient] = this._clientForRecipient(recipient)
  if (!rclient) return

  rclient.on('receive', function (msg) {
    // emit message from whoever `recipient` is
    self.emit('message', msg, recipient)
  })

  rclient.on('send', function (msg) {
    msg = self._encode(msg, recipient)
    self._uclient.send(msg)
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
