/**
 * Exposes a function which accepts an `inspectionSet` object and
 * returns an express.js format route handler. When the route is invoked, the 
 * definitions in inspectionSet are executed and status object returned.
 * @type {module}
 */

var _            = require('lodash');
var os           = require('os');
var Promise      = require('bluebird');
var childProcess = require('child_process');
var request      = require('request');
var PerfTimer    = require('performance-now');
var diskspace    = Promise.promisifyAll(require('diskspace'));


var ensureHttp200 = Promise.promisify(function(url, callback) {
	request(url, { timeout: 10000 }, function (error, response, body) {
		if (error) {
			return callback(error, false);
		}
		return callback(null, response.statusCode === 200);
	});
});

var getCpuPercent = function(load) {
	var numCpu = os.cpus().length;
	var val = (load / numCpu) * 100;
	return Math.round(val * 100) / 100;
};

var healthCheckServer = function() {
	var result = {};
	var memPercent = (process.memoryUsage().heapTotal / os.totalmem()) * 100;
	result.process_memory_used_percent = Math.round(memPercent * 100) / 100;
	result.uptime_minutes = Math.round((process.uptime() / 60) * 100) / 100;
	var cpuLoad = os.loadavg();
	result.cpu_one_minute_average_percent  = getCpuPercent(cpuLoad[0]);
	result.cpu_five_minute_average_percent = getCpuPercent(cpuLoad[1]);
	result.hostname = os.hostname();
	result.os_free_memory_mb = Math.round((os.freemem() / (1024 * 1024)) * 100) / 100;
	return diskspace.checkAsync('/')
			.then(function(data) {
				var val = (data.used / data.total) * 100;
				result.disk_root_use_percent = Math.round(val * 100) / 100;
				return result;
			})
			.catch(function(err) {
				// The library was unable to retrieve result
				result.disk_root_use_percent = -1;
				return result;
			});
};

var allOk = function(statusFlags) {
	return _.reduce(statusFlags, function(flag, n) { return n && flag; }, true);
};

var statusReply = function(serviceList, statusFlags) {
	var overallFlag = allOk(statusFlags);
	var zipped = _.zip(serviceList, statusFlags);
	var services = [];
	_.each(zipped, function(row) {
		var serviceObj = row[0];
		var code = row[1];
		services.push({ name: serviceObj.name, active: code });
	});
	return {
		status: overallFlag,
		services: services
	}
};

var executeApis = function(apis) {
	if (apis) {
		return Promise.map(apis, function(api) {
			return ensureHttp200(api.url);
		})
		.then(_.partial(statusReply, apis));
	}
	return Promise.resolve([]);
};

var executeFunctions = function(functions) {
	if (functions) {
		return Promise.map(functions, function(serviceObj) {
					return serviceObj.fn.call(null);
				})
				.then(_.partial(statusReply, functions));
	}

	return Promise.resolve([]);
};

var orchestrate = function(inspectionSet) {
	var apis = inspectionSet.apis;
	var functions = inspectionSet.functions;
	var result = {};

	var serverPromise = healthCheckServer()
						.then(function(data) {
							result.server = data;
						});

	var apisPromise = executeApis(apis)
						.then(function(apiStatus) {
							result.apis = apiStatus;
						});

	var functionsPromise = executeFunctions(functions)
							.then(function(funcStatus) {
								result.functions = funcStatus;
							});

	return Promise.join(apisPromise, functionsPromise, serverPromise)
			.then(function() {
				var responseStatus = 200;
				// Todo: Pending discussion
				// If we return 500 for bad check then the ELB will
				// remove the box after 5 such failures. Which can be
				// castastrophic in situations and also not having the
				// box will inhibit investigations.
				// if (!result.apis.status || !result.functions.status) {
				// 	responseStatus = 500;
				// }
				return {
					status: responseStatus,
					data: result
				};
			});
		
};

var getHealthCheck = function(inspectionSet) {
	return function(req, res, next) {
		try {
			orchestrate(inspectionSet)
				.then(function(info) {
					res.send(info.status, info);
				})
				.catch(function(err) {
					res.send(200, { status: 200, data: { message: err.message } });
					if (global.Raven) {
						Raven.captureException(err);
					}
				});
		} catch(e) {
			// No point in failing this route
			var resp = { message: e.message }
			res.send(200, { status: 200, data: resp });
		}
	};
};

module.exports = {
	getRouteHandler: getHealthCheck
}

module.exports.setupEndpoints = function (server, routeURI) {
	server.get(routeURI, getHealthCheck);
};