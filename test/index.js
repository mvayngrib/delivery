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

// test.only('disconnect', function (t) {
//   var a = new Connection()
//   a._id = 'a'
//   var b = new Connection()
//   b._id = 'b'

//   createFaultyConnection(a, b, function () {
//     // good connection
//     return true
//   })

//   var aToB = ['hey', 'ho']
//   var bToA = ['who', 'you', 'calling', 'ho?']
//   var togo = 2 * (aToB.length + bToA.length) // 2-way ticket for each message
//   t.plan(togo)

//   // a.send(aToB[0])
//   aToB.forEach(msg => {
//     a.send(msg, () => {
//       t.pass('a delivered')
//       finish()
//     })
//   })

//   process.nextTick(function () {
//     bToA.forEach(msg => {
//       b.send(msg, () => {
//         t.pass('b delivered')
//         finish()
//       })
//     })
//   })

//   a.on('receive', msg => {
//     msg = msg.toString()
//     // console.log('a received ' + msg)
//     t.deepEqual(msg, bToA.shift())
//     finish()
//   })

//   var disconnected
//   b.on('receive', msg => {
//     msg = msg.toString()
//     // console.log('b received ' + msg)
//     t.deepEqual(msg, aToB.shift())
//     finish()
//     if (disconnected) return

//     // t.pass('a delivered')
//     // finish()
//     disconnected = true
//     a._reset(true)
//   })

//   function finish () {
//     if (--togo === 0) {
//       a.destroy()
//       b.destroy()
//     // console.log('bools:', bools)
//     }
//   }
// })

test('basic', function (t) {
  console.log('this tests recovery when more than half the packets\n' +
    'are dropped so give it ~30 seconds to complete')

  var a = new Connection()
  a._id = 'a'
  var b = new Connection()
  b._id = 'b'

  // var bools = []
  // var bools = EVIL[0]

  createFaultyConnection(a, b, function () {
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

  var m = new Messenger({ client: a })
  var n = new Messenger({ client: b })

  var mToN = ['hey'.repeat(1000), 'blah!'.repeat(1234), 'booyah'.repeat(4321)]
  var nToM = ['ho'.repeat(1000), '我饿了'.repeat(3232)]
  // var bools = []
  var togo = 2 * (mToN.length + nToM.length)

  createFaultyConnection(m, n, function () {
    var r = Math.random() < 0.9 ? 1 : 0 // drop some packets
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

test('pause/resume', function (t) {
  var a = new Connection()
  a._id = 'a'
  var b = new Connection()
  b._id = 'b'

  createFaultyConnection(a, b, function () {
    return true
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
    console.log('a received', msg)
    t.deepEqual(msg, bToA.shift())
    finish()
  })

  b.on('receive', msg => {
    msg = msg.toString()
    console.log('b received', msg)
    t.deepEqual(msg, aToB.shift())
    finish()
  })

  ;['send', 'receive'].forEach(function (e) {
    ;[a, b].forEach(function (c) {
      c.on(e, function () {
        if (paused !== c.isPaused()) {
          throw new Error('should be paused!')
        }
      })
    })
  })

  var pausedEver
  var paused = false

  function finish () {
    if (!pausedEver) {
      console.log('paused')
      pausedEver = paused = true
      a.pause()
      b.pause()
      setTimeout(function() {
        console.log('unpaused')
        paused = false
        a.resume()
        b.resume()
      }, 3000)
    }

    if (--togo === 0) {
      a.destroy()
      b.destroy()
    // console.log('bools:', bools)
    }
  }
})

function createFaultyConnection (a, b, filter) {
  ;[a, b].forEach(me => {
    other = me === a ? b : a
    other.on('send', msg => {
      if (filter(msg)) {
        process.nextTick(() => {
          if (!me.isPaused()) {
            me.receive(msg)
          }
        })
      } else {
        // debugger
      }
    })
  })
}
