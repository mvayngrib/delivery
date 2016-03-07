
# sendy

Symmetric (no client/server duality) network-agnostic UTP implementation that can be coupled with the network protocol of your choice, e.g. udp sockets, websockets, snail mail, morse code with lighthouses.

This module is a partial rewrite of [mafintosh](https://github.com/mafintosh)'s awesome [utp](https://github.com/mafintosh/utp) module. I cut out the dependency on udp sockets to make it network-agnostic, and the dependency on streams because as great as they are, using them is much simpler in documentation than in practice. The messy cleanup stage where you might or might not get end-of-stream events is somehow never promoted to people's attention. Who knows, maybe this implementation will eventually find its way back to streams.

# Rationale

There are network-facing and network-agnostic clients. Network-agnostic clients implement guaranteed in-order delivery, encryption, whatever else, and network-facing clients (e.g. a udp socket, a websocket) are just mouthpieces and earpieces.

Network-agnostic clients are designed to be layered, e.g. OTR on the outside, then length-prefixed messages for chunking and re-assembly, then UTP for guaranteed delivery. This stack can then hooked up to the network client.

# Example

```js
var OTRClient = require('sendy-otr') // OTR layer
var MessageClient = require('sendy') // enables message reassembly from UTP packets
var Connection = Sendy.Connection    // symmetric UTP protocol
var networkClient = ...              // must implement `send` method and 'receive' event

var client = new OTRClient({
  key: new DSA(),
  theirFingerprint: 'their otr fingerprint',
  client: new MessageClient({
    client: new Connection({
      mtu: 1500
    })
  })
})

client.on('send', function (msg) {
  // use unreliable network client
  // and guarantee delivery
  networkClient.send(msg)
})

networkClient.on('receive', function (msg) {
  // get a message from the network
  // process it through pipeline
  client.receive(msg)
})
```
