var EventEmitter = require('events').EventEmitter
var test = require('tape')
var Switchboard = require('../switchboard')
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

test('disconnect', function (t) {
  var random = Math.random
  var i = 0

  var a = new Connection()
  a._id = 'a'
  var b = new Connection()
  b._id = 'b'

  createFaultyConnection(a, b, function () {
    // good connection
    return true
  })

  var aToB = ['hey', 'ho', 'merry', 'christmas']
  var bToA = ['who', 'you', 'calling', 'ho?']
  var togo = 2 * (aToB.length + bToA.length) // 2-way ticket for each message
  t.plan(togo)

  var aReceived = {}
  var bReceived = {}

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
    if (!aReceived[msg]) {
      aReceived[msg] = true
      finish()
    }
  })

  var disconnected
  b.on('receive', msg => {
    msg = msg.toString()
    // console.log('b received ' + msg)
    if (!bReceived[msg]) {
      bReceived[msg] = true
      finish()
    }

    if (disconnected) return

    disconnected = true
    a._reset(true)
  })

  function finish () {
    if (--togo === 0) {
      aToB.forEach(msg => {
        t.equal(bReceived[msg], true)
      })

      bToA.forEach(msg => {
        t.equal(aReceived[msg], true)
      })

      a.destroy()
      b.destroy()
    // console.log('bools:', bools)
    }
  }
})

test('basic', function (t) {
  console.log('this tests recovery when more than half the packets\n' +
    'are dropped so give it ~30 seconds to complete')

  var a = new Connection({ resendInterval: 100 })
  a._id = 'a'
  var b = new Connection({ resendInterval: 100 })
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
  t.timeoutAfter(30000)

  var ac = new Connection({ resendInterval: 100 })
  ac._id = 'a'
  var bc = new Connection({ resendInterval: 100 })
  bc._id = 'b'

  var a = new Messenger({ client: ac })
  var b = new Messenger({ client: bc })

  var aToB = ['hey'.repeat(1000), 'blah!'.repeat(1234), 'booyah'.repeat(4321)]
  var bToA = ['ho'.repeat(1000), '我饿了'.repeat(3232)]
  // var bools = []
  var togo = 2 * (aToB.length + bToA.length)

  createFaultyConnection(ac, bc, function () {
    var r = Math.random() < 0.5 ? 1 : 0 // drop some packets
    // bools.push(r)
    return r
  })

  t.plan(togo)

  aToB.forEach(msg => {
    a.send(msg, () => {
      t.pass('a delivered ' + abbr(msg))
      finish()
    })
  })

  process.nextTick(function () {
    bToA.forEach(msg => {
      b.send(msg, () => {
        t.pass('b delivered ' + abbr(msg))
        finish()
      })
    })
  })

  // var aRecvIdx = 0
  // var bRecvIdx = 0
  a.on('receive', msg => {
    msg = msg.toString()
    console.log('a received ' + abbr(msg))
    t.deepEqual(msg, bToA.shift())
    finish()
  })

  b.on('receive', msg => {
    msg = msg.toString()
    console.log('b received ' + abbr(msg))
    t.deepEqual(msg, aToB.shift())
    finish()
  })

  function finish () {
    if (--togo === 0) {
      a.destroy()
      b.destroy()
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

test('switchboard', function (t) {
  t.timeoutAfter(5000)
  var names = ['a', 'b', 'c']
  var blocked = {}
  var unreliables = names.map(function (name) {
    // these are 100% reliable, but that's not what we're testing here
    var ee = new EventEmitter()
    ee.name = name
    ee.destroy = function () {}
    ee.send = function (msg) {
      if (blocked[name]) return

      var to = unreliables.filter(function (u) {
        return u.name === msg.to
      })[0]

      process.nextTick(function () {
        to.emit('receive', msg)
      })
    }

    return ee
  })

  var msgs = ['hey', 'ho']
  var switchboards = names.map(function (name, i) {
    var s = new Switchboard({
      unreliable: unreliables[i],
      encode: function (msg, to) {
        return {
          data: msg,
          from: name,
          to: to
        }
      }
    })

    s.on('message', function (msg, from) {
      msg = msg.toString()

      t.equal(msg, 'hey!')
      t.equal(from, names[0])

      blocked[from] = true
    })

    return s
  })

  switchboards[0].send(names[1], 'hey!', function () {
    switchboards[0].send(names[1], 'ho!', function (err) {
      t.ok(err)
    })

    setTimeout(function () {
      blocked = {}
      switchboards[0].cancelPending()
      setTimeout(function () {
        switchboards.forEach(function (s) {
          s.destroy()
        })

        t.end()
      }, 1000)
    }, 1000)
  })
})

function createFaultyConnection (a, b, filter) {
  ;[a, b].forEach(me => {
    other = me === a ? b : a
    other.on('send', msg => {
      if (filter(msg)) {
        process.nextTick(() => {
          if (!(me.isPaused && me.isPaused())) {
            me.receive(msg)
          }
        })
      } else {
        // debugger
      }
    })
  })
}

function abbr (msg) {
  return msg.slice(0, 10) + '...'
}
