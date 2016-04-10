// var WHY = require('why-is-node-running')
var EventEmitter = require('events').EventEmitter
var test = require('tape')
var Sendy = require('../sendy')
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

  // var dialogue = {
  //   a: {
  //     connection: a,
  //     msgs: ['hey', 'ho', 'merry', 'christmas'],
  //   },
  //   b: {
  //     connection: b,
  //     msgs: ['who', 'you', 'calling', 'ho?']
  //   }
  // }

  // var togo = 2
  // Object.keys(dialogue).forEach((name, i) => {
  //   var msgs = dialogue[name]
  //   var str = msgs.join('')
  //   togo += msgs.length
  //   if (i === 0) send()
  //   else process.nextTick(send)

  //   function send () {
  //     msgs.forEach(msg => {

  //     })
  //   }
  // })

  var aToB = ['hey', 'ho', 'merry', 'christmas']
  var bToA = ['who', 'you', 'calling', 'ho?']
  var togo = (aToB.length + bToA.length) + 2 // 2-way ticket for each message
  t.plan(togo)

  // var aReceived = {}
  // var bReceived = {}

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

  var aToBStr = aToB.join('')
  var aReceived = ''
  a.on('receive', msg => {
    if (aReceived === bToAStr) return

    msg = msg.toString()
    console.log('a received ' + msg)
    aReceived += msg
    t.equal(bToAStr.indexOf(aReceived), 0)
    if (bToAStr === msg) {
      finish()
    }

    // if (!aReceived[msg]) {
    //   aReceived[msg] = true
    //   finish()
    // }
  })

  var disconnected
  var bToAStr = bToA.join('')
  var bReceived = ''
  b.on('receive', msg => {
    if (bReceived === aToBStr) return

    msg = msg.toString()
    console.log('b received ' + msg)
    // if (!bReceived[msg]) {
    //   bReceived[msg] = true
    //   finish()
    // }
    bReceived += msg
    t.equal(aToBStr.indexOf(bReceived), 0)
    if (aToBStr === msg) {
      finish()
    }

    if (disconnected) return

    disconnected = true
    a._reset(true)
  })

  function finish () {
    if (--togo === 0) {
      // aToB.forEach(msg => {
      //   t.equal(bReceived[msg], true)
      // })

      // bToA.forEach(msg => {
      //   t.equal(aReceived[msg], true)
      // })

      a.destroy()
      b.destroy()
    // console.log('bools:', bools)
    }
  }
})

test('timeout', function (t) {
  var a = new Connection({ resendInterval: 100 })
  a._id = 'a'
  var b = new Connection({ resendInterval: 100 })
  b._id = 'b'

  // var bools = []
  // var bools = EVIL[0]

  var timedOut = false
  var allow = true

  a.setTimeout(500)
  a.on('timeout', function () {
    timedOut = true
  })

  createFaultyConnection(a, b, function () {
    return allow
  })

  var aToB = ['hey']
  var bToA = ['ho']

  var aInterval = setInterval(function () {
    aToB.forEach(msg => {
      a.send(msg)
    })
  }, 300)

  var bInterval = setInterval(function () {
    bToA.forEach(msg => {
      b.send(msg)
    })
  }, 300)

  setTimeout(function () {
    t.equal(timedOut, false)
    clearInterval(aInterval)
    clearInterval(bInterval)
    var timeout = setTimeout(function () {
      t.equal(timedOut, true)
      a.destroy()
      b.destroy()
      t.end()
    }, 1000)
  }, 2000)
})

test('length-prefixed transport', function (t) {
  t.timeoutAfter(30000)

  var ac = new Connection({ resendInterval: 100 })
  ac._id = 'a'
  var bc = new Connection({ resendInterval: 100 })
  bc._id = 'b'

  var a = new Messenger({ client: ac })
  var b = new Messenger({ client: bc })

  var aToB = ['hey'.repeat(5e5), 'blah!'.repeat(1234), 'booyah'.repeat(4321)]
  var bToA = ['ho'.repeat(5e5), '我饿了'.repeat(3232)]

  var bools = []
  var togo = 2 * (aToB.length + bToA.length)

  createFaultyConnection(ac, bc, function () {
    // return bools.shift()
    var r = Math.random() < 0.5 ? 1 : 0 // drop some packets
    bools.push(r ? 1 : 0)
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
      // console.log('bools:', '[' + bools.join(',') + ']')
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
  var togo = 2 + (aToB.length + bToA.length) // 2-way ticket for each message
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
    t.deepEqual(msg, bToA.join(''))
    finish()
  })

  b.on('receive', msg => {
    msg = msg.toString()
    // console.log('b received ' + msg)
    t.deepEqual(msg, aToB.join(''))
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
  var togo = 2 + (aToB.length + bToA.length) // 2-way ticket for each message
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
    t.deepEqual(msg, bToA.join(''))
    finish()
  })

  b.on('receive', msg => {
    msg = msg.toString()
    console.log('b received', msg)
    t.deepEqual(msg, aToB.join(''))
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

test('switchboard disconnect', function (t) {
  // t.timeoutAfter(5000)
  var names = ['a', 'b', 'c'].slice(0, 2)
  var blocked = {}
  // var waitForTimeout
  // var waitedForTimeout
  // var cliffJumper = 'a'
  var disconnected
  var reconnected
  var unreliables = names.map(function (name, i) {
    // these are 100% reliable, but that's not what we're testing here
    var ee = new EventEmitter()
    ee.on('connect', function () {
      if (disconnected) {
        disconnected = false
        reconnected = true
      }
    })

    ee.on('disconnect', function () {
      disconnected = true
    })

    ee.name = name
    ee.destroy = function () {}
    ee.send = function (msg) {
      if (blocked[name]) return

      var to = unreliables.filter(function (u) {
        return u.name === msg.to
      })[0]

      process.nextTick(function () {
        // if (!waitForTimeout) {
        if (!disconnected) {
          to.emit('receive', msg)
        }
        // } else {
        //   console.log('no')
        // }
      })
    }

    ee.on('disconnect', function () {
      switchboards[i].cancelPending()
    })

    return ee
  })

  var cliffJumper = unreliables[0]
  // var msgs = ['hey'.repeat(5e5), 'ho', 'blah!'.repeat(1234), 'booyah'.repeat(4321), 'ooga']
  // var msgs = ['hey'.repeat(20000)]//, 'ho'.repeat(100), 'blah!', 'booyah', 'ooga']
  var msgs = ['hey'.repeat(4), 'ho!'.repeat(4), 'yay'.repeat(4), 'poop', 'blah'.repeat(4)]
  var togo = msgs.length * names.length * (names.length - 1) * 2 // send and receive
  // t.plan(togo)

  var received = {
    from: {}
  }

  var delivered = {
    from: {}
  }

  names.forEach(function (me) {
    received.from[me] = {
      to: {}
    }
    delivered.from[me] = {
      to: {}
    }

    names.forEach(function (them) {
      if (me !== them) {
        received.from[me].to[them] = []
        delivered.from[me].to[them] = []
      }
    })
  })

  var switchboards = names.map(function (myName, i) {
    var s = new Switchboard({
      unreliable: unreliables[i],
      clientForRecipient: function (recipient) {
        return new Sendy({
          mtu: 2,
          // client: newBadConnection()
        })
      },
      encode: function (msg, to) {
        return {
          data: msg,
          from: myName,
          to: to
        }
      }
    })

    var toRecv = {}
    var prev = {}
    names.forEach(function (other, j) {
      if (i === j) return

      toRecv[other] = msgs.slice()
    })

    s.on('message', function (msg, from) {
      msg = msg.toString()
      if (prev[from] === msg) return // disconnect side-effect

      prev[from] = msg
      var expected = toRecv[from].shift()
      t.equal(msg, expected)
      // t.ok(delivered.from[from].to[myName].length < toRecv[from].length)
      received.from[from].to[myName].push(msg)
      finish()
    })

    // s.on('timeout', function (recipient) {
    //   t.comment('forced timeout')
    //   // waitedForTimeout = true
    //   // waitForTimeout = false

    //   s.cancelPending(recipient)
    // })

    // s.setTimeout(500)

    return s
  })

  switchboards.forEach(function (sender, i) {
    var myName = names[i]
    names.forEach(function (receiver, j) {
      if (i === j) return

      var toSend = msgs.slice()
      sendNext()

      function sendNext () {
        var msg = toSend.shift()
        if (!msg) return

        sender.send(receiver, msg, function (err) {
          if (err) {
            toSend.unshift(msg)
            console.log(myName, 'resending to', names[j], err, toSend.length)
          } else {
            delivered.from[myName].to[receiver].push(msg)
            if (!disconnected && !reconnected && toSend.length === 2) {
              process.nextTick(function () {
                cliffJumper.emit('disconnect')
                setTimeout(function () {
                  cliffJumper.emit('connect')
                }, 2000)
              })
            }

            // t.pass(`${names[i]} delivered msg to ${receiver}, ${toSend.length} to go `)
            finish() // delivered
          }

          sendNext()
        })
      }
    })
  })

  function finish () {
    if (--togo === 0) {
      names.forEach(function (me) {
        names.forEach(function (them) {
          if (me !== them) {
            t.deepEqual(delivered.from[me].to[them], received.from[me].to[them])
          }
        })
      })

      cleanup()
    }
  }

  function cleanup () {
    switchboards.forEach(function (s) {
      s.destroy()
    })

    t.end()
  }

  // function newBadConnection (opts) {
  //   var c = new Connection(opts)
  //   var receive = c.receive
  //   c.receive = function () {
  //     // if (!waitForTimeout) {
  //       return receive.apply(this, arguments)
  //     // } else {
  //     //   console.log('no')
  //     // }
  //   }
  // }
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
