"use strict";

var mraa = require('mraa'),
    http = require('http'),
    querystring = require('querystring'),
    mqtt = require('mqtt'),
    fs = require('fs'),
    crypto = require('crypto'),
    request = require('request');


var rConfigFile = "rconfig.json",
    sConfigFile = "sconfig.json",
    lConfigFile = "lconfig.json",
    modeReceive = false,
    modeSend = false,
    modeListen = false;

function argsHaveParam(i, succCallback, errCallback) {
    if (i == process.argv.length || process.argv[i].indexOf("-") == 0) {
        return false
    } else {
        return true
    }
}

function fail(printHelp, msg) {
    if (msg) { console.log(msg); }
    if (printHelp) {
        console.log("usage: [--sconfig config.json --rconfig config.json -r -s -l]\n -r for receive or -s for sending -l for listening");
        console.log("-r, -s, -l or all required");
        console.log("-s for sending by by get request")
        console.log("-r for listening by mqtt, -l for checking value through API");
        console.log("looking for rconfig.json and sconfig.json files by default");
    }
	process.exit(0);
}

for (var i = 2; i < process.argv.length; i++) {
	var argument = process.argv[i];
	switch (argument) {
		case "-r":
    modeReceive = true;
			break;
		case "-s":
            modeSend = true;
			break;
      case "-l":
            modeListen = true;
            break;
        case "--rconfig":
            if (argsHaveParam(++i)) {
                rConfigFile = process.argv[i];
            } else {
                fail(false, "rconfig file name not specified");
            }
            break;
        case "--sconfig":
            if (argsHaveParam(++i)) {
                sConfigFile = process.argv[i];
            } else {
                fail(false, "sconfig file name not specified");
            }
            break;
          case "--lconfig":
          if (argsHaveParam(++i)) {
              lconfigFile = process.argv[i];
          } else {
              fail(false, "sconfig file name not specified");
          }
          break
    }
}


if (!modeReceive && !modeSend && !modeListen) {
    fail(true);
}

function getConfig(fileName) {
    try {
        var file = fs.readFileSync(fileName, "utf8");
        return JSON.parse(file);
    } catch(err) {
        console.log(err);
        fail(false, fileName+ " does not exist or corrupted, one can specify file with --config");
    }
}

// validate portName
function getPort(portName, dir) {
    if (dir == "out" && portName[1] == "A") {
        fail(false, "Cannot write to analog port " + portName);
    }

    function failWithPort() {
        fail(false, "Wrong port: " + portName);
    }

    var portNumber = parseInt(portName.substring(1));
    if (isNaN(portNumber) || portNumber < 0) {
        failWithPort();
    }

    var port = null;
    if (portName[0] == "D") {
        if (portNumber > 13) {
            failWithPort();
        }
        port = new mraa.Gpio(portNumber);
        port.dir(dir == "in" ? mraa.DIR_IN : mraa.DIR_OUT);
    } else if (portName[0] == "A") {
        if (portNumber > 5) {
            failWithPort();
        }
        port = new mraa.Aio(portNumber);
    } else {
        fail(false, "Wrong port: " + portName);
    }
    return port;
}

var receiveMap = {}
var receiveAnswerUrl = null;
if (modeReceive) {
    var config = getConfig(rConfigFile);
    receiveAnswerUrl = config.answerUrl
    var client = mqtt.connect(config.url, { protocolId: 'MQIsdp', protocolVersion: 3,connectTimeout: 10 * 1000 });
    config.targets.map( function(target) {
        receiveMap[target.username + "/thing/" + target.did] = target.port;
    });

    client.on('connect', function () {
        console.log("Connected");
        for (var key in receiveMap) {
            client.subscribe(key);
            console.log("Subsribed to " + key);
        }
    });

    client.on('error', function(error) {
        console.log("Recieved CONNACK");
        fail(false, error.toString());
    });

    client.on('message', function (topic, message) {
        var tpc = topic.toString();
        var msg = message.toString();
        console.log("Received, topic: " + tpc);
        console.log("Message: " +  msg);
        var portName = receiveMap[tpc];
        var valuePosition = msg.indexOf("value");
        var value = msg.charAt(valuePosition + 6);
        var port = getPort(portName, "out");
        port.write(parseInt(value));

        var didPosition = tpc.lastIndexOf("/");
        var did = tpc.substring(didPosition + 1);
        var query = querystring.stringify({ did: did, action: "ack", value: value });
        var url =  receiveAnswerUrl + "?" + query;
        console.log("Sending response: " + url);
        try {
            http.get(url);
        } catch (error) {
            fail(false, "Network error");
        }
    });
    client.on('close', function() {
        console.log("Connection closed");
    });

    client.on('offline', function() {
        console.log("Offline");
    });

    client.on('reconnect', function() {
        console.log("Reconnect");
    });
}

if (modeSend) {
    var config = getConfig(sConfigFile);
    config.targets.map( function(target) {
        var port = getPort(target.port, "in");
        sendData(port, target.url, target.did, target.period, function(result, value) {
            var json = JSON.parse(result);
            if (json.status == "success") {
                console.log("Sent " + value + ", did: " + target.did + " (" + target._name + ")");
            } else {
                console.log("ERROR");
                console.log(json.message);
            }
            console.log();
        });
    });
}

var token = null;
var userId = null;
var listenTable = {};
if (modeListen) {
  var config = getConfig(lConfigFile);
  var login = config.login;
  var password = config.password;
  var url = config.url;
  var period = config.period;
  loginToApi(login, password, url, function(token, userID) {
    for (var i = 0; i < config.targets.length; i++) {
      var target = config.targets[i];
      var port = target.port;
      var did = target.did;
      listenTable[did] = port;
    }

    console.log(listenTable);
    getDevices(url, token, userId, period, function(things) {
      things.map( function(thing) {
        //console.log(thing);
        var portName = listenTable[thing.did];
        if (portName) {
          var port = getPort(portName, "out");
          var value = parseInt(thing.value);
          if (isNaN(value)) {
            value = 0
          }
          port.write(value);
          console.log("Wrote " + value + " to port " + portName + " (did:" + did + " )");
          if (!value) {
            //console.log("Received value is: " + thing.value);
            console.log("Thing:\n + " + JSON.stringify(thing));
          }
          console.log();
        }
      });
    });
  });
}

function loginToApi(login, pass, baseUrl, callback) {
  var hashedPass = crypto.createHash("md5").update(pass).digest("hex");
  var params = querystring.stringify();
  var url = baseUrl + "/api/login"
  request.post({ url: url, form: { login: login, password: hashedPass } },
    function(err, response, body) {
      if (err != null) {
        fail(false, "Network error, failed to login");
      } else {
        var result = JSON.parse(body);
        if (result.status != "success") {
          fail(false, "Wrong login or pass");
        }
        token = result.token;
        userId = result.user_id;
        console.log("Successfully logged in API")
        callback(token, userId);
      }
    });
}

function getDevices(baseUrl, token, userId, period, callback) {
  var url = baseUrl + "/api/mythings";
  function helper(url, token, userId, period, callback) {
    request.post({ url: url, form: { user_id: userId, token: token } } ,
      function(err, response, body) {
        if (err != null) {
          fail(false, "Network error, failed to get things list");
        } else {
          var result = JSON.parse(body);
          if (result.status != "success") {
            console.log(result.message);
            fail(false, "Failed to get things list");
          }
          callback(result.things);
        }
        setTimeout(helper, period, url, token, userId, period, callback);
    });
  }
  helper(url, token, userId, period, callback);
}

function sendData(port, url, did, period, callback) {
    if (url.charAt(url.length - 1) != "/") {
        url = url + "/"
    }
    function helper(port, url, did, period, callback) {
        var value = port.read();
        request({ url: url, qs: {did: did, action: "put", value: value} },
      function (error, response, body) {
        callback(body, value);
      });
        setTimeout(helper, period, port, url, did, period, callback);
    }
    helper(port, url, did, period, callback);
}
