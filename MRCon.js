var app = require("express")();
var http = require('http').Server(app);
var io = require("socket.io")(http);
const mongo = require("mongodb").MongoClient;
const bodyParser = require('body-parser');
const cors = require('cors')
const { dialogflow } = require('actions-on-google');
app.use(bodyParser.json());
app.use(cors());
const dialogflowApp = dialogflow({ debug: true });

app.post('/fulfillment', dialogflowApp);

mongo.connect("mongodb+srv://rahulc292:D6BdOxjVVag3atAO@mrcon.reenr8u.mongodb.net/?retryWrites=true&w=majority").then(client => {
  console.log("Connected to MongoDB server");

  const db = client.db("MRCon");
  const collection = db.collection("Devices");
  const presenceCollection = db.collection("Presence");
  const ota_UpdatesCollection = db.collection("OTA_Updates");

  const changeStream = collection.watch([], { fullDocument: "updateLookup" });
  const presenceChangeStream = presenceCollection.watch([], { fullDocument: "updateLookup" });

  changeStream.on("change", async function (event) {
    if (event.fullDocument) {
      if (event.operationType == "replace" || event.operationType == "update") {
        if (event.fullDocument.IsActive) {
          io.emit(event.fullDocument.DeviceId, event.fullDocument);
        }
        else {
          io.emit(event.fullDocument.UserId, event.fullDocument);
          if (event.fullDocument.UserId != event.fullDocument.CreatedBy)
            await collection.deleteOne({ 'UserId': event.fullDocument.UserId, 'DeviceId': event.fullDocument.DeviceId });
        }
      }
      else if (event.operationType == "insert") {
        io.emit(event.fullDocument.UserId, event.fullDocument);
      }

      if (event.fullDocument.UserId == event.fullDocument.CreatedBy) {
        const device = await collection.findOne({ 'UserId': event.fullDocument.UserId, 'DeviceId': event.fullDocument.DeviceId }, {});
        if (device)
          io.emit(event.fullDocument.DeviceId + '-Device', device);
      }
    }
  });

  presenceChangeStream.on("change", function (event) {
    if (event.fullDocument) {
      io.emit(event.fullDocument.UserId + '-Presence', event.fullDocument);
    }
  });

  io.on('connection', (socket) => {
    socket.on('DeviceConnected', async (result) => {
      const deviceType = await ota_UpdatesCollection.findOne({ 'DeviceType': result.DeviceType }, {});
      var device = await collection.findOne({ 'IsActive': true, 'DeviceId': result.DeviceId, 'UserId': result.UserId }, {});
      if (device) {
        if (deviceType)
          device.UpdateVersion = deviceType.UpdateVersion;
        io.emit(result.DeviceId + '-Device', device);
      }
      else
        io.emit(result.DeviceId + '-DeviceReset', device);
    });

    socket.on('UpdateDocumentFromDevice', async (result) => {
      var tempResult = Object.assign({}, result);
      delete tempResult.TimeStamp;
      const device = await collection.findOne({ 'DeviceId': result.DeviceId }, {});
      if (device) {
        if (device.UpdatedOn) {
          var updatedOnDateTime = new Date(device.UpdatedOn);
          updatedOnDateTime.setSeconds(updatedOnDateTime.getSeconds() + 3);
          var currentDateTime = new Date();
          if (updatedOnDateTime.getTime() <= currentDateTime.getTime())
            await collection.updateMany({ 'DeviceId': result.DeviceId }, { $set: tempResult }, { upsert: true });
        }
        else {
          await collection.updateMany({ 'DeviceId': result.DeviceId }, { $set: tempResult }, { upsert: true });
        }
        await presenceCollection.updateMany({ 'DeviceId': result.DeviceId }, { $set: { 'TimeStamp': result.TimeStamp } }, { upsert: true });
      }
    });
  });

  app.post('/UpdateDocument', async (req, res) => {
    req.body.UpdatedOn = new Date().getTime();
    delete req.body.UserId;
    const updateDoc = {
      $set: req.body
    };
    await collection.updateMany({ 'DeviceId': req.body.DeviceId }, updateDoc, { upsert: true }).then(function (result) {
      res.status(200).end();
    }, function () {
      res.status(500).end();
    });
  });

  app.post('/InsertDocument', async (req, res) => {
    const updateDoc = {
      $set: req.body
    };
    await collection.deleteMany({ 'DeviceId': req.body.DeviceId });
    await presenceCollection.deleteMany({ 'DeviceId': req.body.DeviceId });
    await presenceCollection.updateOne({ 'DeviceId': req.body.DeviceId, 'UserId': req.body.UserId }, { $set: { 'TimeStamp': 0 } }, { upsert: true });
    await collection.updateOne({ 'DeviceId': req.body.DeviceId, 'UserId': req.body.UserId }, updateDoc, { upsert: true }).then(function (result) {
      res.status(200).end();
    }, function () {
      res.status(500).end();
    });
  });

  app.post('/DeleteDocument', async (req, res) => {
    const device = await collection.findOne({ 'IsActive': true, 'DeviceId': req.body.DeviceId, 'UserId': req.body.UserId }, {});
    if (device) {
      if (device.UserId == device.CreatedBy) {
        const updateDoc = {
          $set: { 'IsActive': req.body.IsActive, 'IsReset': req.body.Reset }
        };
        await collection.updateMany({ 'DeviceId': req.body.DeviceId }, updateDoc, { upsert: true }).then(function () {
          res.status(200).end();
        }, function () {
          res.status(500).end();
        });
      }
      else {
        const updateDoc = {
          $set: { 'IsActive': req.body.IsActive }
        };
        await collection.updateMany({ 'DeviceId': req.body.DeviceId, 'UserId': req.body.UserId }, updateDoc, { upsert: true }).then(function () {
          res.status(200).end();
        }, function () {
          res.status(500).end();
        });
      }
    }
  });

  app.get('/GetUserDevices', async (req, res) => {
    var devices = [];
    const cursor = collection.find({ 'UserId': req.query.UserId, 'IsActive': true }, {});
    await cursor.forEach(function (val, key) {
      devices.push(val);
    });
    res.contentType('application/json');
    res.send(devices);
  });

  dialogflowApp.intent('MRConCooler', async (conv, { action, status }) => {

    return new Promise((resolve, reject) => {
      resolve(conv.ask(action + '    ' + status));
    });
  });
});

http.listen(3000, function () {
  console.log("Listening on 3000");
});