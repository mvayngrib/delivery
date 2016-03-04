
var test = require('tape')
var Deliverer = require('../')
var EVIL = [
[ 1, 0, 0, 1, 0, 0, 1, 1, 0, 1, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1 ]
  // [ 0, 1, 0, 1, 1, 0, 1, 1 ]
  // [],
  // [ 1, 0 ],
  // [ 1, 0, 0, 1, 1, 0, 0],
  // [ 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 1, 0, 1, 0, 1 ]
]

test('basic', function (t) {
  t.plan(2)

  // var prev = 0
  var mathRandom = Math.random
  // Math.random = function() {
  //   prev += 0.001
  //   return prev
  // }

  var a = new Deliverer()
  a._id = 'a'
  var b = new Deliverer()
  b._id = 'b'

  var bools = []
  // var bools = EVIL[0]

  connect(a, b, function () {
    // var r = bools.length ? bools.shift() : 1
    var r = mathRandom() < 0.1 ? 1 : 0
    bools.push(r)
    return r
  })

  var aToB = ['hey']
  var bToA = ['ho']
  aToB.forEach(msg => {
    a.send(msg, () => {
      console.log('a delivered')
    })
  })

  process.nextTick(function () {
    bToA.forEach(msg => {
      b.send(msg, () => {
        console.log('b delivered')
      })
    })
  })

  var togo = 2
  a.on('message', msg => {
    msg = msg.toString()
    console.log('a received ' + msg)
    t.deepEqual(msg, bToA.shift())
    finish()
  })

  b.on('message', msg => {
    msg = msg.toString()
    console.log('b received ' + msg)
    t.deepEqual(msg, aToB.shift())
    finish()
  })

  a.on('connect', () => console.log('a connected'))
  b.on('connect', () => console.log('b connected'))

  process.on('SIGTERM', function () {
    console.log(bools)
    process.exit(1)
  })

  process.on('SIGINT', function () {
    console.log(bools)
    process.exit(1)
  })

  function finish () {
    if (--togo === 0) {
      a.destroy()
      b.destroy()
      console.log('bools:', bools)
    }
  }
})

function connect (a, b, filter) {
  ;[a, b].forEach(me => {
    other = me === a ? b : a
    other.on('send', msg => {
      if (filter(msg)) {
        process.nextTick(() => {
          me.receive(msg)
        })
      } else {
        // debugger
      }
    })
  })
}
