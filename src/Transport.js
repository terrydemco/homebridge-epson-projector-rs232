'use strict';

const debug = require('debug')('ESCVP21');
const serial = require('debug')('ESCVP21:serial');

const SerialPort = require('serialport');
const EventEmitter = require('events').EventEmitter;

const Backoff = require('backoff');
const SequentialTaskQueue = require('sequential-task-queue').SequentialTaskQueue;

const TransportStates = {
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  CONNECTED: 'connected'
};

function noop() {
}

class Transport extends EventEmitter {

  constructor(port, log) {
    super();
	this.log = log;
    this._currentRx = Buffer.alloc(0);
    this._pendingReads = [];
    this._command = 0;

    this._port = new SerialPort(port, {
      autoOpen: true,
      baudRate: 19200,
      dataBits: 8,
      stopBits: 1,
      parity: 'none'
    });

    this._port.on('open', this._onSerialPortOpened.bind(this));
    this._port.on('close', this._onSerialPortClosed.bind(this));
    this._port.on('error', this._onSerialPortFailed.bind(this));
    this._port.on('data', this._onSerialPortData.bind(this));

    this._backoff = new Backoff.exponential({
      initialDelay: 100,
      maxDelay: 60000
    });
    this._backoff.on('backoff', this._onBackoffStarted.bind(this));
    this._backoff.on('ready', this._connect.bind(this));

    this._taskQueue = new SequentialTaskQueue();

    this.state = TransportStates.DISCONNECTED;
  }

  _onSerialPortOpened() {
    this._onDisconnected();
  }

  _onSerialPortClosed(err) {
    this.log(`SignalPort closed: ${err}`);
    this._changeState(TransportStates.DISCONNECTED);
  }

  _onSerialPortFailed(err) {
    this.log(`SerialPort signaled error: ${err}`);
    this.emit('error', err);
  }

  _onSerialPortData(data) {
    data = Buffer.from(data);
    serial(`SerialPort received ${JSON.stringify(data)}`);

    this._currentRx = Buffer.concat([this._currentRx, data]);
    serial(`SerialPort now pending ${JSON.stringify(this._currentRx)}`);

    // Verify if this a complete line
    this._handlePendingData();
  }

  execute(cmd, timeout) {
    if (this.state !== TransportStates.CONNECTED) {
      throw new Error('Not connected');
    }

    // Default timeout of 10s = 10000
    timeout = timeout || 10000;

    // Append a \r to the string
    cmd = cmd + '\r';

    return this._execute(cmd, timeout);
  }

  _execute(cmd, timeout) {
    return this._taskQueue.push(async () => {
      const commandId = this._command++;

      let response = null;
      for (let attempt = 0; response === null && attempt < 3; attempt++) {
        this.log(`Begin processing command ${commandId} - attempt #${attempt}`);
        this.log(`command: ${cmd}`);
        const timeoutPromise = this._createTimeout(timeout);
        const readPromise = this._scheduleRead();
        await this._sendCommand(cmd);

        response = await Promise.race([readPromise, timeoutPromise]);
        if (response === null) {
          this.log('Command execution timed out.');
          this._synchronize();
        }
      }


      this.log(`Done processing command ${commandId}: response=${JSON.stringify(response)}`);
      if (response === null) {
        throw new Error('Command execution timed out.');
      }
      if (response.startsWith('ERR\r:')) {
        throw new Error('Unsupported command');
      }

      return response;
    });
  }


  _sendCommand(cmd) {
    return new Promise((resolve, reject) => {
      this.log(`Sending ${cmd}`);
      this._port.write(cmd, 'ascii', (err) => {
        if (err) {
          reject(err);
        }

        resolve();
      });
    });
  }

  async _scheduleRead() {
    const promise = new Promise(resolve => {
      this._pendingReads.push(resolve);
      if (this._pendingReads.length === 1) {
        // Check if we have an incoming pending data block
        this._handlePendingData();
      }
    });

    return promise;
  }

  _handlePendingData() {
    const readyMarker = this._currentRx.indexOf(':');
    if (readyMarker !== -1) {
      const line = this._currentRx.slice(0, readyMarker + 1).toString('ascii');
      this._currentRx = this._currentRx.slice(readyMarker + 1);

      serial(`Processing response ${JSON.stringify(line)}, remaining ${JSON.stringify(this._currentRx)}`);

      const pendingRead = this._pendingReads.shift() || noop;
      pendingRead(line);
    }
  }

  _changeState(state) {
    this.log(`Changing state to ${state}`);

    switch (state) {
      case TransportStates.CONNECTING:
        this._onConnecting();
        break;

      case TransportStates.CONNECTED:
        this._onConnected();
        break;
    }

    this.state = state;
    this.emit(state);
  }

  _onConnecting() {
    this.log('Connecting to projector...');
  }

  _onConnected() {
    this.log('Connected to projector...');
    this._backoff.reset();

    // TODO: Initiate connection check timer?
  }

  _onDisconnected() {
    debug('Disconnected from projector...');
    this._backoff.backoff();
  }

  async _synchronize() {
    serial('Synchronizing with projector...');

    let synchronized = false;
    for (let attempt = 0; attempt < 3 && synchronized === false; attempt++) {
      await this._drainAndFlush();

      synchronized = await this._sendNullCommand();
      if (synchronized === false) {
        await this._createTimeout(2000);
      }
    }

    serial(`Synchronization completed... ${synchronized ? 'succesful' : 'FAILED'}`);
    return synchronized;
  }

  _drainAndFlush() {
    return new Promise((resolve, reject) => {
      serial('Drain rx queue');
      this._currentRx = Buffer.alloc(0);
      this._pendingReads.forEach(p => p(null));
      this._pendingReads = [];

      this._port.flush(err => {
        if (err) {
          reject(err);
          return;
        }

        this._port.drain(err => {
          if (err) {
            reject(err);
            return;
          }

          resolve();
        });
      });
    });
  }

  async _sendNullCommand() {
    serial('Sending empty command to poll status');
    try {
      const response = await this._execute('#get input \r', 1000);

      const colonPos = response.indexOf(':');

      return colonPos !== -1 && colonPos === (response.length - 1);
    }
    catch (e) {
      serial(`Failed to send empty command. ${e}`);
      return false;
    }
  }

  _onBackoffStarted(delay) {
    this.log(`Attempting to reconnect in ${delay / 1000} seconds.`);
  }

  async _connect() {
    if (await this._synchronize() === true) {
      this._changeState(TransportStates.CONNECTED);
    }
  }

  _createTimeout(timeout) {
    return new Promise(resolve => {
      setTimeout(() => resolve(null), timeout);
    });
  }
}

module.exports = Transport;
