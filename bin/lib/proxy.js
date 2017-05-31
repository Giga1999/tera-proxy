const REGION = require('../config.json').region

const REGIONS = {
	NA: {
		url: 'http://sls.service.enmasse.com:8080/servers/list.en',
		hostname: 'sls.service.enmasse.com',
		port: 8080,
		customServers: require('./res/servers-na.json'),
		listenHostname: '127.0.0.10'
	},
	EU: {
		hostname: 'web-sls.tera.gameforge.com',
		port: 4566,
		pathname: ['/servers/list.uk', '/servers/list.de', '/servers/list.fr'],
		customServers: require('./res/servers-eu.json'),
		listenHostname: '127.0.0.11'
	},
	RU: {
		url: 'http://launcher.tera-online.ru/launcher/sls/',
		hostname: 'launcher.tera-online.ru',
		port: 80,
		customServers: require('./res/servers-ru.json'),
		listenHostname: '127.0.0.12'
	},
	KR: {
		url: 'http://tera.nexon.com/launcher/sls/servers/list.xml',
		hostname: 'tera.nexon.com',
		port: 80,
		customServers: require('./res/servers-kr.json'),
		listenHostname: '127.0.0.13'
	},
	JP: {
		url: 'http://tera.pmang.jp/game_launcher/server_list.xml?usn=0',
		hostname: 'tera.pmang.jp',
		port: 80,
		customServers: require('./res/servers-jp.json'),
		listenHostname: '127.0.0.14'
	},
	TW: {
		url: 'http://tera.mangot5.com/game/tera/serverList.xml',
		hostname: 'tera.mangot5.com',
		port: 80,
		customServers: require('./res/servers-tw.json'),
		listenHostname: '127.0.0.15'
	}
}

if(!REGIONS[REGION]) {
	console.error('Unsupported region: ' + REGION)
	return
}

let why
try {
	why = require('why-is-node-running')
} catch (_) {}

// requires
const fs = require('fs')
const net = require('net')
const path = require('path')
const dns = require('dns')

const hosts = require('./hosts')

const SlsProxy = require('tera-proxy-sls')
const { Connection, RealClient } = require('tera-proxy-game')

// check if hosts is writable
try {
	hosts.remove(REGIONS[REGION].listenHostname, REGIONS[REGION].hostname)
} catch (e) {
	switch (e.code) {
		case 'EACCES': {
			console.error(`
*********************************
*                               *
*  FAILED TO WRITE HOSTS FILE!  *
*  ---------------------------  *
*     FILE SET TO READ-ONLY     *
*                               *
*********************************

Your hosts file seems to be set to read-only.
Find this file and make sure it's writable:
(Right-click, Properties, uncheck Read-only)

    ${e.path}
`)
			break
		}

		case 'EPERM': {
			console.error(`
*********************************
*                               *
*  FAILED TO WRITE HOSTS FILE!  *
*  ---------------------------  *
*     RUN AS ADMINISTRATOR!     *
*                               *
*********************************

You don't have sufficient privileges to create or modify the hosts file.
Please try again by right-clicking and selecting "Run as administrator".
`)
			break
		}

		default: {
			throw e
		}
	}

	process.exit(1)
}

/********
 * main *
 ********/
const customServers = REGIONS[REGION].customServers
const proxy = new SlsProxy(REGIONS[REGION])

// load modules
const modules = (
	fs.readdirSync(path.join(__dirname, '..', 'node_modules'))
		.filter(name => name[0] !== '.' && name[0] !== '_')
)

// cache
console.log('[proxy] preloading modules')
for (let name of modules) {
	try {
		require(name)
	} catch (e) {
		console.warn()
		console.warn(`[proxy] failed to load "${name}"`)
		console.warn(e.stack)
		console.warn()
	}
}

dns.setServers(['8.8.8.8', '8.8.4.4'])

// fetch official server list
proxy.fetch((err, gameServers) => {
	if (err) {
		if(err.code != 'EACCES') throw err

		let port = REGIONS[REGION].port

		console.error('Another process is already using port ' + port + '.\nPlease close or uninstall the application first:')

		let netstat = require('child_process').spawn('netstat', ['-abno', '-p', 'TCP']),
			chunks = []

		netstat.stdout.on('data', data => {
			chunks.push(data)
		})

		netstat.on('exit', () => {
			let lines = Buffer.concat(chunks).toString().split('\n')

			for(let i = 0; i < lines.length; i++) lines[i] = lines[i].trim().replace(/ +/g, ' ').split(' ')

			for(let i = 0; i < lines.length; i++) {
				let line = lines[i]

				if(line[0] == 'TCP' && line[1] == '0.0.0.0:' + port && line[2] == '0.0.0.0:0') {
					let proc

					for(let i2 = 1; i2 < 4; i2++) {
						if(!lines[++i] || lines[i].length != 1) break
						if(proc = /\[(.+?)\]/.exec(lines[i])) {
							proc = proc[1]
							break
						}
					}

					console.log((proc || 'unknown') + ':' + line[4])
				}
			}

			process.exit()
		})

		return
	}

	// set up proxy servers
	const servers = new Map()

	for (let id in customServers) {
		const target = gameServers[id]
		if (!target) {
			console.error(`server ${id} not found`)
			continue
		}

		const server = net.createServer((socket) => {
			socket.setNoDelay(true)

			const connection = new Connection()
			const client = new RealClient(connection, socket)
			const srvConn = connection.connect(client, { host: target.ip, port: target.port })

			for (let name of modules) {
				connection.dispatch.load(name, module)
			}

			// logging
			let remote = '???'

			socket.on('error', (err) => {
				console.warn(err)
			})

			srvConn.on('connect', () => {
				remote = socket.remoteAddress + ':' + socket.remotePort
				console.log('[connection] routing %s to %s:%d',
					remote, srvConn.remoteAddress, srvConn.remotePort)
			})

			srvConn.on('error', (err) => {
				console.warn(err)
			})

			srvConn.on('close', () => {
				console.log('[connection] %s disconnected', remote)
			})
		})

		servers.set(id, server)
	}

	// run sls proxy
	proxy.listen(REGIONS[REGION].listenHostname, () => {
		hosts.set(REGIONS[REGION].listenHostname, REGIONS[REGION].hostname)
		console.log('[sls] server list overridden')

		// run game proxies
		for (let [id, server] of servers) {
			server.listen(customServers[id].port, customServers[id].ip || '127.0.0.1', () => {
				const address = server.address()
				console.log(`[game] listening on ${address.address}:${address.port}`)
			})
		}
	})

	// set up exit handling
	if (process.platform === 'win32') {
		require('readline')
			.createInterface({ input: process.stdin, output: process.stdout })
			.on('SIGINT', () => {
				process.emit('SIGINT')
			})
	}

	function cleanExit() {
		console.log('terminating...')

		try {
			hosts.remove(REGIONS[REGION].listenHostname, REGIONS[REGION].hostname)
		} catch (_) {}

		proxy.close()
		servers.forEach(server => server.close())

		if (process.platform === 'win32') {
			process.stdin.pause()
		}

		setTimeout(() => {
			why && why()
			process.exit()
		}, 5000).unref()
	}

	process.on('SIGHUP', cleanExit)
	process.on('SIGINT', cleanExit)
	process.on('SIGTERM', cleanExit)
})
