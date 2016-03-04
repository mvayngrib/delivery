module.exports = function bitArray (size) {
  var buckets = []

  for (var i = 0; i < Math.ceil(size / 32); i++) {
    buckets[i] = 0
  }

  return {
    size: function () {
      return size
    },

    set: function (index, value) {
      var i = Math.floor(index / 32)

      // Since "undefined | 1 << index" is equivalent to "0 | 1 << index" we do not need to initialise the array explicitly here.
      if (value) {
        buckets[i] |= 1 << index - i * 32
      } else {
        buckets[i] &= ~(1 << index - i * 32)
      }
    },

    get: function (index) {
      var i = Math.floor(index / 32)
      return buckets[i] & (1 << index - i * 32)
    }
  }
}

