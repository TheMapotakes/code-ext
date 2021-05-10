
(function() {
    var ext = this;
    var C = require('constants')
    var fs = require('fs');
    var child_process = require('child_process');
    var commandPipeName = "/tmp/gr-control/command.pipe";
    var txMsgPipeName = "/tmp/gr-control/txmessage.pipe";
    var rxMsgPipeName = "/tmp/gr-control/rxmessage.pipe";
    var commandPipe = null;
    var txMsgPipe = null;
    var rxMsgPipe = null;
    var txMsgStart = false;
    var rxMsgStart = false;
    var radioRunning = false;
    var rxMsgBufSize = 1024;
    var rxMsgBufThreshold = 768;
    var rxMsgBuffer = Buffer.alloc(rxMsgBufSize);
    var rxMsgOffset = 0;
    var messageBitRate = 1200;
    var sampleRate = 400000;
    var errorCallbacks = [];
    var componentNameSet = new Set();
    var componentNameHook = null;

    // Fires up the GNU Radio script for subsequent use.
    var radioDriver = null
    child_process.spawn('lxterminal', ['-e',
        '/usr/lib/scratch2/scratch_extensions/start_gnu_radio.sh']);

    // Send a command via the command pipe. Implements lazy open of
    // command pipe file.
    this._sendCommand = function(command) {
        if (commandPipe == null) {
            commandPipe = fs.openSync(commandPipeName, 'a');
        }
        fs.appendFileSync (commandPipe, command + "\n");
    }

    // Send a message via the transmit message pipe.
    this._sendMessage = function(message) {
        if (txMsgPipe != null) {
            fs.appendFileSync (txMsgPipe, message + "\n");
        }
    }

    // Issues an error message to any error listeners.
    this._errorMessage = function(message) {
        while (errorCallbacks.length > 0) {
            var callback = errorCallbacks.pop();
            callback(message);
        }
    }

    // Checks for duplicate component names.
    this._checkComponentAbsent = function(componentName) {
        if (componentNameSet.has(componentName)) {
            this._errorMessage("Duplicate component name : " + componentName);
            return false;
        } else {
            componentNameSet.add(componentName);
            return true;
        }
    }

    // Check for existing component names.
    this._checkComponentPresent = function(componentName) {
        if (!componentNameSet.has(componentName)) {
            this._errorMessage("Component not found : " + componentName);
            return false;
        } else {
            return true;
        }
    }

    // Implicitly connects up a data source.
    this._connectDataSource = function(componentName) {
        if (componentNameHook != null) {
            this._errorMessage("Source component should not have an input : " + componentName);
            return false;
        } else {
            componentNameHook = componentName;
            return true;
        }
    }

    // Implicitly connects up a data sink.
    this._connectDataSink = function(componentName) {
        if (componentNameHook == null) {
            this._errorMessage("Sink component must have an input : " + componentName);
            return false;
        } else {
            this._sendCommand("CONNECT " + componentNameHook + " 0 " + componentName + " 0");
            componentNameHook = null;
            return true;
        }
    }

    // Implicitly connects up a data processing component.
    this._connectDataProcessor = function(componentName) {
        if (componentNameHook == null) {
            this._errorMessage("Data processing component must have an input : " + componentName);
            return false;
        } else {
            this._sendCommand("CONNECT " + componentNameHook + " 0 " + componentName + " 0");
            componentNameHook = componentName;
            return true;
        }
    }

    // Receive a message via the response message pipe.
    this._receiveMessage = function(callback) {
        if (rxMsgPipe == null) {
            this._errorMessage("Radio Not Running");
            callback("");
        } else if (rxMsgOffset >= rxMsgBufThreshold) {
            this._processRxMessage(callback);
        } else {
            fs.read(rxMsgPipe, rxMsgBuffer, rxMsgOffset, rxMsgBufSize-rxMsgOffset, null,
                function(err, len, buf) {
                    if (err == null) {
                        if (len == 0) {
                            setTimeout(this._receiveMessage, 1000, callback);
                        } else {
                            rxMsgOffset += len;
                            this._processRxMessage(callback);
                        }
                    } else if (err.code == "EAGAIN") {
                        if (rxMsgOffset > 0) {
                            this._processRxMessage(callback);
                        } else {
                            setTimeout(this._receiveMessage, 1000, callback);
                        }
                    } else {
                        this._errorMessage("Rx Message Error : " + err.code);
                        callback("");
                    }
                }
            );
        }
    }

    // Process a received message.
    this._processRxMessage = function(callback) {
        var rxMsgString;
        for (var i = 0; i < rxMsgOffset; i++) {

            // On detecting an end of line character, copy the line to
            // the received message string and shift the residual buffer
            // contents down.
            if (rxMsgBuffer[i] == 10) {
                rxMsgString = rxMsgBuffer.toString('ascii', 0, i);
                if (i == rxMsgOffset-1) {
                    rxMsgOffset = 0;
                } else {
                    rxMsgBuffer.copy(rxMsgBuffer, 0, i+1, rxMsgOffset);
                    rxMsgOffset -= i+1;
                }
                break;
            }
        }

        // Invoke callback or retry.
        if (rxMsgString == null) {
            if (rxMsgOffset >= rxMsgBufSize) {
                rxMsgOffset -= 1;
            }
            setTimeout(this._receiveMessage, 1000, callback);
        } else {
            callback(rxMsgString);
        }
    }

    // Cleanup function when the extension is unloaded.
    ext._shutdown = function() {
        if (commandPipe != null) {
            fs.closeSync(commandPipe);
            commandPipe = null;
        }
        if (txMsgPipe != null) {
            fs.closeSync(txMsgPipe);
            txMsgPipe = null;
        }
        if (rxMsgPipe != null) {
            fs.closeSync(rxMsgPipe);
            rxMsgPipe = null;
        }
        if (radioDriver != null) {
            radioDriver.kill('SIGHUP');
            radioDriver = null;
        }
    };

    // Status reporting code. Checks for the availability of the GNU Radio
    // control pipe.
    ext._getStatus = function() {
        if (!fs.existsSync(commandPipeName)) {
            return {status: 0, msg: 'No GNU Radio command pipe found'};
        }
        if (!fs.existsSync(txMsgPipeName)) {
            return {status: 0, msg: 'No GNU Radio transmit pipe found'};
        }
        if (!fs.existsSync(rxMsgPipeName)) {
            return {status: 0, msg: 'No GNU Radio receive pipe found'};
        }
        return {status: 2, msg: 'Ready'};
    };

    // Block for resetting the GNU Radio service.
    ext.radioReset = function() {
        if (radioRunning) {
            this.radioStop()
        }
        txMsgStart = false;
        rxMsgStart = false;
        componentNameSet.clear();
        componentNameHook = null;
        this._sendCommand("RESET");
    }

    // Block for starting the GNU Radio service.
    ext.radioStart = function() {
        this._sendCommand("START");
        if (txMsgStart && (txMsgPipe == null)) {
            txMsgPipe = fs.openSync(txMsgPipeName, 'a');
        }
        if (rxMsgStart && (rxMsgPipe == null)) {
            rxMsgPipe = fs.openSync(rxMsgPipeName, C.O_NONBLOCK);
        }
        radioRunning = true;
    }

    // Block for stopping the GNU Radio service.
    ext.radioStop = function() {
        this._sendCommand("STOP");
        radioRunning = false;
        if (txMsgPipe != null) {
            fs.closeSync(txMsgPipe);
            txMsgPipe = null;
        }
        if (rxMsgPipe != null) {
            // TODO: This discards the local message buffer but we don't
            // currently discard any residual input FIFO file contents.
            rxMsgOffset = 0;
            fs.closeSync(rxMsgPipe);
            rxMsgPipe = null;
        }
    }

    // Determine if the radio has been started.
    ext.isRadioRunning = function() {
        return radioRunning;
    }

    // Block for creating a new SoapySDR radio source.
    ext.createRadioSource = function(name, frequency, gain) {
        if (this._checkComponentAbsent(name)) {
            var scaledFreq = frequency * 1e6;
            this._sendCommand("CREATE RADIO-SOURCE " + name + " " + scaledFreq + " " + gain);
            this._connectDataSource(name);
        }
    };

    // Block for creating a new SoapySDR radio sink.
    ext.createRadioSink = function(name, frequency, gain) {
        if (this._checkComponentAbsent(name)) {
            var scaledFreq = frequency * 1e6;
            this._sendCommand("CREATE RADIO-SINK " + name + " " + scaledFreq + " " + gain);
            this._connectDataSink(name);
        }
    };

    // Block for creating a new display plot sink.
    // TODO: Add configuration parameters.
    ext.createDisplaySink = function(type, name, frequency) {
        if (this._checkComponentAbsent(name)) {
            var scaledFreq = frequency * 1e6;
            this._sendCommand("CREATE DISPLAY-SINK " + name + " " +
                type.toUpperCase() + " " + scaledFreq + " " + sampleRate);
            this._connectDataSink(name);
        }
    }

    // Block for creating a transmit message source.
    ext.createMessageSource = function(name) {
        if (this._checkComponentAbsent(name)) {
            txMsgStart = true;
            this._sendCommand("CREATE MESSAGE-SOURCE " + name +
                " " + txMsgPipeName + " " + (messageBitRate / 8));
            this._connectDataSource(name);
            if (txMsgPipe == null) {
                txMsgPipe = fs.openSync(txMsgPipeName, 'a');
            }
        }
    }

    // Block for creating a receive message sink.
    ext.createMessageSink = function(name) {
        if (this._checkComponentAbsent(name)) {
            rxMsgStart = true;
            this._sendCommand("CREATE MESSAGE-SINK " + name + " " + rxMsgPipeName);
            this._connectDataSink(name);
            if (rxMsgPipe == null) {
                rxMsgPipe = fs.openSync(rxMsgPipeName, C.O_NONBLOCK);
            }
        }
    }

    // Block for creating a simple transmit framer.
    ext.createSimpleFramer = function(name) {
        if (this._checkComponentAbsent(name)) {
            this._sendCommand("CREATE SIMPLE-FRAMER " + name);
            this._connectDataProcessor(name);
        }
    }

    // Block for creating a simple receive deframer.
    ext.createSimpleDeframer = function(name) {
        if (this._checkComponentAbsent(name)) {
            this._sendCommand("CREATE SIMPLE-DEFRAMER " + name);
            this._connectDataProcessor(name);
        }
    }

    // Block for creating a Manchester encoder.
    ext.createManchesterEncoder = function(name) {
        if (this._checkComponentAbsent(name)) {
            this._sendCommand("CREATE MANCHESTER-ENCODER " + name);
            this._connectDataProcessor(name);
        }
    }

    // Block for creating a Manchester decoder.
    ext.createManchesterDecoder = function(name) {
        if (this._checkComponentAbsent(name)) {
            this._sendCommand("CREATE MANCHESTER-DECODER " + name);
            this._connectDataProcessor(name);
        }
    }

    // Block for creating an OOK modulator.
    ext.createOokModulator = function(name, modFreq) {
        if (this._checkComponentAbsent(name)) {
            this._sendCommand("CREATE OOK-MODULATOR " + name + " " +
                2 * messageBitRate + " " + sampleRate + " " + Math.floor(modFreq*1000));
            this._connectDataProcessor(name);
        }
    }

    // Block for creating an OOK demodulator.
    ext.createOokDemodulator = function(name) {
        if (this._checkComponentAbsent(name)) {
            this._sendCommand("CREATE OOK-DEMODULATOR " + name + " " +
                2 * messageBitRate + " " + sampleRate);
            this._connectDataProcessor(name);
        }
    }

    // Block for creating a bit rate sampler.
    ext.createBitRateSampler = function(name) {
        if (this._checkComponentAbsent(name)) {
            this._sendCommand("CREATE BIT-RATE-SAMPLER " + name + " " +
                2 * messageBitRate + " " + sampleRate);
            this._connectDataProcessor(name);
        }
    }

    // Block for creating a new low pass filter.
    ext.createLowPassFilter = function(name, bandwidth) {
        if (this._checkComponentAbsent(name)) {
            this._sendCommand("CREATE LOW-PASS-FILTER " + name + " " +
                sampleRate + " " + 1000 * bandwidth + " 1");
            this._connectDataProcessor(name);
        }
    }

    // Block for creating a new band pass filter.
    ext.createBandPassFilter = function(name, lowCutoff, highCutoff) {
        if (this._checkComponentAbsent(name)) {
            this._sendCommand("CREATE BAND-PASS-FILTER " + name + " " +
                sampleRate + " " + 1000 * lowCutoff + " " + 1000 * highCutoff + " 1");
            this._connectDataProcessor(name);
        }
    }

    // Block for creating a simple connection from an existing data producer.
    ext.makeSimpleConnection = function(producer) {
        if (this._checkComponentPresent(producer)) {
            this._connectDataSource(producer);
        }
    }

    // Send a fixed message over the radio.
    ext.sendSimpleMessage = function(message) {
        this._sendMessage(message);
    }

    // Receive a message over the radio.
    ext.receiveSimpleMessage = function(callback) {
        this._receiveMessage(callback);
    }

    // Receive an error message.
    ext.receiveErrorMessage = function(callback) {
        errorCallbacks.push(callback);
    }

    // Block and block menu descriptions
    var descriptor = {
        blocks: [
            // Block type, block name, function name
            [' ', 'reset radio', 'radioReset'],
            [' ', 'start radio', 'radioStart'],
            [' ', 'stop radio', 'radioStop'],
            ['b', 'radio running', 'isRadioRunning'],
            [' ', 'send message %s', 'sendSimpleMessage', 'Hello World'],
            ['R', 'receive message', 'receiveSimpleMessage'],
            ['R', 'receive error', 'receiveErrorMessage'],
            [' ', '\u2533 radio source %s at %n MHz, gain %n dB', 'createRadioSource', 'lime-source', 433.92, 40],
            [' ', '\u2533 message source %s', 'createMessageSource', 'tx-message'],
            [' ', '\u2513 source data from %s', 'makeSimpleConnection', 'producer'],
            [' ', '\u253B radio sink %s at %n MHz, gain %n dB', 'createRadioSink', 'lime-sink', 433.92, 40],
            [' ', '\u253B display %m.display_type sink %s at %n MHz', 'createDisplaySink', 'spectrum', 'spectrum', 433.92],
            [' ', '\u253B message sink %s', 'createMessageSink', 'rx-message'],
            [' ', '\u2503 simple framer %s', 'createSimpleFramer', 'tx-framer'],
            [' ', '\u2503 simple deframer %s', 'createSimpleDeframer', 'rx-deframer'],
            [' ', '\u2503 Manchester encoder %s', 'createManchesterEncoder', 'mcr-encoder'],
            [' ', '\u2503 Manchester decoder %s', 'createManchesterDecoder', 'mcr-decoder'],
            [' ', '\u2503 OOK modulator %s at %n kHz', 'createOokModulator', 'ook-modulator', sampleRate/8000],
            [' ', '\u2503 OOK demodulator %s', 'createOokDemodulator', 'ook-demodulator'],
            [' ', '\u2503 bit rate sampler %s', 'createBitRateSampler', 'bit-sampler'],
            [' ', '\u2503 low pass filter %s with bandwidth %n KHz', 'createLowPassFilter', 'lp-filter', sampleRate/4000],
            [' ', '\u2503 band pass filter %s with pass band %n KHz to %n KHz', 'createBandPassFilter', 'bp-filter', sampleRate/16000, 3*sampleRate/16000],
        ],
        menus:{
            display_type: ['spectrum', 'waterfall']
        }
    };

    // Register the extension
    ScratchExtensions.register('Scratch Radio', descriptor, ext);
})({});
