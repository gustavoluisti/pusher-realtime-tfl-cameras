// TODO: Requesting individual camera images will result in faster updates
// - Seems camera feed is updated less often than the images are
// - Comparing new image to existing image to work out if it has changed
// - Could perhaps use headers for checking, then request full image if updated

var _ = require("underscore");
var request = require("request");
var JXON = require("jxon");
var DOMParser = require("xmldom").DOMParser;

var silent = false;

var config;
try {
  config = require("./config");
} catch(e) {
  console.log("Failed to find local config, falling back to environment variables");
  config = {
    app_id: process.env.PUSHER_APP_ID,
    key: process.env.PUSHER_APP_KEY,
    secret: process.env.PUSHER_APP_SECRET
  }
}

var express = require("express");
var bodyParser = require("body-parser");
var errorHandler = require("errorhandler");

var app = express();
var root = __dirname + "/demo";


// --------------------------------------------------------------------
// SET UP PUSHER
// --------------------------------------------------------------------
var Pusher = require("pusher");
var pusher = new Pusher({
  appId: config.app_id,
  key: config.key,
  secret: config.secret
});

// --------------------------------------------------------------------
// SET UP EXPRESS
// --------------------------------------------------------------------

// Parse application/json and application/x-www-form-urlencoded
app.use(bodyParser.urlencoded({
  extended: true
}));
app.use(bodyParser.json());

// Simple logger
app.use(function(req, res, next){
  console.log("%s %s", req.method, req.url);
  console.log(req.body);
  next();
});

// Error handler
app.use(errorHandler({
  dumpExceptions: true,
  showStack: true
}));

// Serve static files from directory
app.use(express.static(root));

// Get all cameras
app.get("/cameras", function(req, res) {
  res.json(cameras);
});

// Open server on specified port
if (!silent) console.log("Starting Express server");
app.listen(process.env.PORT || 5001);

// --------------------------------------------------------------------
// TfL
// --------------------------------------------------------------------
var tflURL = "http://www.tfl.gov.uk/tfl/livetravelnews/trafficcams/cctv/jamcams-camera-list.xml";

var lastUpdated;
var cameras = {};

var staleCameras;
var errorRetryTime = 2000;

var scrapeTimer;
var scrapeRequest;

var onResponse = function(error, response, body) {
  if (error || response.statusCode != 200) {
    if (!silent) console.log("Request failed, re-attempting");
    if (!silent) console.log(error);
    if (!silent) console.log(response);

    errorRetryTime *= 1.5;

    if (errorRetryTime > 30000) {
      errorRetryTime = 30000;
    }

    scrapeTimer = setTimeout(requestCameras, errorRetryTime);

    return;
  }

  errorTimeout = 2000;
  staleCameras = 0;

  var jxon = JXON.build(new DOMParser().parseFromString(body).documentElement);
  // console.log(JSON.stringify(jxon, null, 2));
  //console.log(JSON.stringify(jxon));

  var header = jxon.header;

  if (header.publishdatetime - lastUpdated === 0) {
    if (!silent) console.log("No change");
    scrapeTimer = setTimeout(requestCameras, 10000);
    return;
  }

  // console.log(header);

  lastUpdated = header.publishdatetime;

  var cameraList = jxon.cameralist;

  var output = [];

  _.each(cameraList.camera, function(camera, index) {
    // Don't use inactive cameras
    // if (!camera["@available"]) {
    //   return;
    // }

    // console.log(camera["@id"], index);
    // console.log("http://tfl.gov.uk" + cameraList.rooturl + camera.file);

    if (!cameras[camera["@id"]]) {
      cameras[camera["@id"]] = camera;
      output.push(camera.file.replace(".jpg", ""));
    // Only update cameras that have changed or that have a broken date
    } else if (camera.capturetime - cameras[camera["@id"]].capturetime > 0 || camera.capturetime.getFullYear() === 1970) {
      output.push(camera.file.replace(".jpg", ""));
    // Camera hasn't been updated
    } else {
      staleCameras++;
    }
  });

  if (!silent) console.log(output.length + " updated cameras");
  if (!silent) console.log(staleCameras + " stale cameras");
  
  var data = output.join("|");

  // console.log(data);

  pusher.trigger("cameras", "cameras-update", data);

  scrapeTimer = setTimeout(requestCameras, 10000);
};

var requestCameras = function() {
  if (!silent) console.log("------------------------------------------");
  if (!silent) console.log(new Date().toString());

  if (!silent) console.log("Clearing scrape timer");
  clearTimeout(scrapeTimer);

  scrapeRequest = request(tflURL, onResponse);
};

requestCameras();

// Capture uncaught errors
process.on("uncaughtException", function(err) {
  console.log(err);

  if (!silent) console.log("Attempting to restart scraper");

  if (!silent) console.log("Aborting previous request");
  if (scrapeRequest) {
    scrapeRequest.abort();
  }

  requestCameras();
});