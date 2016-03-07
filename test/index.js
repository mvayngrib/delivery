var test = require('tape')
var Connection = require('../connection')
var Messenger = require('../')
var EVIL = [
  [ 1, 0, 0, 1, 0, 0, 1, 1, 0, 1, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1 ]
// [ 0, 1, 0, 1, 1, 0, 1, 1 ]
// [],
// [ 1, 0 ],
// [ 1, 0, 0, 1, 1, 0, 0],
// [ 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 1, 0, 1, 0, 1 ]
]

test('basic', function (t) {
  console.log('this tests recovery when more than half the packets\n' +
    'are dropped so give it ~30 seconds to complete')

  var a = new Connection()
  a._id = 'a'
  var b = new Connection()
  b._id = 'b'

  // var bools = []
  // var bools = EVIL[0]

  connect(a, b, function () {
    // var r = bools.length ? bools.shift() : 1
    var r = Math.random() < 0.3 ? 1 : 0 // drop some packets
    // bools.push(r)
    return r
  })

  var aToB = ['hey', 'ho']
  var bToA = ['who', 'you', 'calling', 'ho?']
  var togo = 2 * (aToB.length + bToA.length) // 2-way ticket for each message
  t.plan(togo)

  aToB.forEach(msg => {
    a.send(msg, () => {
      t.pass('a delivered')
      finish()
    })
  })

  process.nextTick(function () {
    bToA.forEach(msg => {
      b.send(msg, () => {
        t.pass('b delivered')
        finish()
      })
    })
  })

  a.on('receive', msg => {
    msg = msg.toString()
    // console.log('a received ' + msg)
    t.deepEqual(msg, bToA.shift())
    finish()
  })

  b.on('receive', msg => {
    msg = msg.toString()
    // console.log('b received ' + msg)
    t.deepEqual(msg, aToB.shift())
    finish()
  })

  // a.on('connect', () => console.log('a connected'))
  // b.on('connect', () => console.log('b connected'))

  // process.on('SIGTERM', function () {
  //   console.log(bools)
  //   process.exit(1)
  // })

  // process.on('SIGINT', function () {
  //   console.log(bools)
  //   process.exit(1)
  // })

  function finish () {
    if (--togo === 0) {
      a.destroy()
      b.destroy()
    // console.log('bools:', bools)
    }
  }
})

test('length-prefixed transport', function (t) {
  var a = new Connection()
  a._id = 'a'
  var b = new Connection()
  b._id = 'b'

  var m = new Messenger({ connection: a })
  var n = new Messenger({ connection: b })

  var mToN = ['hey'.repeat(1000), 'blah!'.repeat(1234), 'booyah'.repeat(4321)]
  var nToM = ['ho'.repeat(1000), '我饿了'.repeat(3232)]
  // var bools = []
  var togo = 2 * (mToN.length + nToM.length)

  connect(m, n, function () {
    var r = Math.random() < 0.3 ? 1 : 0 // drop some packets
    // bools.push(r)
    return r
  })

  t.plan(togo)

  mToN.forEach(msg => {
    m.send(msg, () => {
      t.pass('m delivered')
      finish()
    })
  })

  process.nextTick(function () {
    nToM.forEach(msg => {
      n.send(msg, () => {
        t.pass('n delivered')
        finish()
      })
    })
  })

  m.on('receive', msg => {
    msg = msg.toString()
    // console.log('m received ' + msg)
    t.deepEqual(msg, nToM.shift())
    finish()
  })

  n.on('receive', msg => {
    msg = msg.toString()
    // console.log('n received ' + msg)
    t.deepEqual(msg, mToN.shift())
    finish()
  })

  function finish () {
    if (--togo === 0) {
      m.destroy()
      n.destroy()
    // console.log('bools:', bools)
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
