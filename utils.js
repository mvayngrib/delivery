var reemit = require('re-emitter')
var slice = Array.prototype.slice

exports.toBuffer = function toBuffer (data) {
  if (Buffer.isBuffer(data)) return data

  if (typeof data === 'object') {
    data = JSON.stringify(data)
  }

  if (typeof data === 'string') {
    return new Buffer(data)
  } else {
    throw new Error('expected plain javascript object, Buffer, or string')
  }
}

exports.connect = function connect (/* pipeline */) {
  var top = arguments[0]
  var rest = slice.call(arguments, 1)
  rest.reduce(function (prev, next) {
    // bubble 'send' event
    reemit(next, prev, ['send', 'pause', 'resume'])
    prev.receive = function () {
      // -> forward receive call
      return next.receive.apply(next, arguments)
    }

    if (!prev.pause) prev.pause = next.pause
    if (!prev.resume) prev.resume = next.resume
  }, top)
}
