const ivm = require('isolated-vm')
const hub = require('odo-hub')
const access = require('./access')
const instances = {}

const create = (app) => {
  let code = app.code
  const incoming = hub()
  const outgoing = hub()
  let isolate = null
  let internal = null
  const result = {
    appId: app.appId,
    on: outgoing.on,
    off: outgoing.off,
    emit: incoming.emit,
    start: () => {
      isolate = new ivm.Isolate()
      internal = hub()
      // let emitEmitter = null
      let publish = () => {}
      internal.on('req', (req, res) => {
        publish('req', req.url)
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.end('okay')
      })
      incoming.unhandled(internal.emit)
      internal.unhandled(publish)
      isolate.createContext().then((context) => Promise.all([
        context.global.set('global', context.global.derefInto()),
        context.global.set('_ivm', ivm),
        context.global.set('_emit', new ivm.Reference(outgoing.emit)),
        context.global.set('_on', new ivm.Reference((fn) => {
          publish = (...args) => fn.applyIgnored(
            undefined,
            args.map(arg => new ivm.ExternalCopy(arg).copyInto()))
        }))
      ])
      .then(() => isolate.compileScript('new ' + function() {
        const ivm = _ivm; delete _ivm
        const emit = _emit; delete _emit
        const listeners = {}
        global.hub = {
          on: (e, fn) => {
            if (!listeners[e]) listeners[e] = []
            listeners[e].push(fn)
          },
          emit: (...args) => emit.applyIgnored(undefined,
            args.map(arg => new ivm.ExternalCopy(arg).copyInto()))
        }
        _on.applyIgnored(undefined, [
          new ivm.Reference((e, ...args) =>
            listeners[e].forEach((fn) => fn(...args)))])
        delete _on
      }))
      .then((script) => script.run(context))
      .then(() => isolate.compileScript(app.code))
      .then((hostile) => hostile.run(context)))
      .catch(err => {
        if (err.stack) return outgoing.emit('error', err.stack)
        outgoing.emit('error', err.toString())
      })
    },
    stop: () => {
      if (!isolate) return
      incoming.unhandledOff(internal.emit)
      internal = null
      isolate.dispose()
      isolate = null
    },
    update: (app) => {
      code = app.code
      result.stop()
      result.start()
    }
  }
  return result
}

module.exports = {
  open: () => Promise.resolve(Object.values(access.apps).forEach(module.exports.run)),
  close: () =>  Promise.resolve(Object.keys(instances).forEach(module.exports.stop)),
  start: (appId) => {
    if (!instances[appId]) return
    instances[appId].start()
  },
  stop: (appId) => {
    if (!instances[appId]) return
    instances[appId].stop()
  },
  update: (app) => {
    if (!instances[app.appId]) return
    instances[appId].update(app)
  },
  run: (app) => {
    if (!instances[app.appId]) {
      const instance = create(app)
      instances[app.appId] = instance
      instance.start()
    } else { instances[app.appId].update(app) }
  },
  on: (appId, e, cb) => {
    if (!instances[appId]) return
    instances[appId].on(e, cb)
  },
  off: (appId, e, cb) => {
    if (!instances[appId]) return
    instances[appId].off(e, cb)
  },
  emit: (appId, e, ...args) => {
    if (!instances[appId]) return
    instances[appId].emit(e, ...args)
  }
}