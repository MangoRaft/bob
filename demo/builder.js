var Docker = require('dockerode');
var fs = require('fs');
var path = require('path');

var Builder = require('../lib/builder');

var socket = process.env.DOCKER_SOCKET || '/var/run/docker.sock';
var stats = fs.statSync(socket);

if (!stats.isSocket()) {
	throw new Error("Are you sure the docker is running?");
}

var docker = new Docker({
	socketPath : socket
});
var b = new Builder({
	docker : docker,
	registry : '127.0.0.1:6000',
	user : 'tommy',
	name : 'demoapp',
	tag : Date.now(),
	folder : path.join(__dirname, 'node'),
	buildpack : 'buildpack'
});

b.on('_dockerFile', function() {
	console.log('_dockerFile');
});
b.on('_buildImage', function() {
	console.log('_buildImage');
});
b.on('_tag', function() {
	console.log('_tag');
});
b.on('_push', function() {
	console.log('_push');
});
b.on('build', function(info) {
	console.log('build', info);
});
b.on('compile', function(line) {
	console.log('compile', line);
});
b.on('step', function(step) {
	console.log('step', step);
});
b.on('commit', function(commit) {
	console.log('commit', commit);
});
b.on('commands', function(cmd) {
	console.log('commands', cmd);
});

b.build();
