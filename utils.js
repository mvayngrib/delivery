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
    next.on('send', function (msg) {
      var args = slice.call(arguments)
      args.unshift('send')
      prev.emit.apply(prev, args)
    })

    prev.receive = function () {
      // -> forward receive call
      return next.receive.apply(next, arguments)
    }
  }, top)
}
