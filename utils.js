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
