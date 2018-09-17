/**
 * Class to represent a multi-request GATT connection.
 */
'use strict';

const sodium = require('libsodium-wrappers');

/**
 * Internal connection state.
 */
const State = {
  DISCONNECTED: 0,
  CONNECTING: 1,
  CONNECTED: 2,
};

class GattConnection {
  /**
   * Initialize the GattConnection object.
   *
   * @param {Object} peripheral - Peripheral object from noble
   */
  constructor(peripheral) {
    this.peripheral = peripheral;
    this.state = State.DISCONNECTED;
    this.sessionKeys = null;
    this.a2cCounter = 0;
    this.c2aCounter = 0;
    this.currentOperation = Promise.resolve();
  }

  _queueOperation(op) {
    this.currentOperation = this.currentOperation
      .then(() => op())
      .catch(() => op());
    return this.currentOperation;
  }

  /**
   * Set the session keys for the connection.
   *
   * @param {Object} keys - The session key object obtained from PairingProtocol
   */
  setSessionKeys(keys) {
    this.sessionKeys = keys;
  }

  /**
   * Connect to the peripheral if necessary.
   *
   * @returns {Promise} Promise which resolves when the connection is
   *                    established.
   */
  connect() {
    if (this.state === State.CONNECTED) {
      return Promise.resolve();
    }

    let initial;
    if (this.state !== State.DISCONNECTED) {
      initial = new Promise((resolve, reject) => {
        this.peripheral.disconnect((err) => {
          if (err) {
            reject(err);
          } else {
            this.state = State.DISCONNECTED;
            resolve();
          }
        });
      });
    } else {
      initial = Promise.resolve();
    }

    return initial.then(() => {
      return new Promise((resolve, reject) => {
        this.state = State.CONNECTING;
        this.peripheral.connect((err) => {
          if (err) {
            reject(err);
          } else {
            this.state = State.CONNECTED;
            resolve();
          }
        });
      });
    });
  }

  /**
   * Disconnect from the peripheral if necessary.
   *
   * @returns {Promise} Promise which resolves when the connection is
   *                    destroyed.
   */
  disconnect() {
    return new Promise((resolve, reject) => {
      if (this.state !== State.DISCONNECTED) {
        this.peripheral.disconnect((err) => {
          if (err) {
            reject(err);
          } else {
            this.state = State.DISCONNECTED;
            resolve();
          }
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Write a series of PDUs to a characteristic.
   *
   * @param {string} serviceUuid - UUID of service
   * @param {string} characteristicUuid - UUID of characteristic
   * @param {Buffer[]} pdus - List of PDUs to send
   * @returns {Promise} Promise which resolves to a list of responses when all
   *                    writes are sent.
   */
  findAndWriteCharacteristic(serviceUuid, characteristicUuid, pdus) {
    return this._queueOperation(() => {
      return this.connect().then(() => {
        return new Promise((resolve, reject) => {
          this.peripheral.discoverSomeServicesAndCharacteristics(
            [serviceUuid],
            [characteristicUuid],
            (err, services, characteristics) => {
              if (err) {
                reject(err);
                return;
              }

              if (services.length === 0 || characteristics.length === 0) {
                reject('Characteristic not found');
                return;
              }

              return this.writeCharacteristic(characteristics[0], pdus);
            }
          );
        });
      });
    });
  }

  /**
   * Encrypt a series of PDUs.
   *
   * @param {Buffer[]} pdus - List of PDUs to encrypt
   * @returns {Buffer[]} List of encrypted PDUs.
   */
  _encryptPdus(pdus) {
    const encryptedPdus = [];

    for (const pdu of pdus) {
      let position = 0;

      while (position < pdu.length) {
        const writeNonce = Buffer.alloc(12);
        writeNonce.writeUInt32LE(this.c2aCounter++, 4);

        const frameLength = Math.min(pdu.length - position, 496);

        const frame = Buffer.from(
          sodium.crypto_aead_chacha20poly1305_ietf_encrypt(
            pdu.slice(position, position + frameLength),
            null,
            null,
            writeNonce,
            this.sessionKeys.ControllerToAccessoryKey
          )
        );

        encryptedPdus.push(frame);
        position += frameLength;
      }
    }

    return encryptedPdus;
  }

  /**
   * Decrypt a series of PDUs.
   *
   * @param {Buffer[]} pdus - List of PDUs to decrypt
   * @returns {Buffer[]} List of decrypted PDUs.
   */
  _decryptPdus(pdus) {
    const decryptedPdus = [];

    for (const pdu of pdus) {
      const readNonce = Buffer.alloc(12);
      readNonce.writeUInt32LE(this.a2cCounter++, 4);

      try {
        const decryptedData = Buffer.from(
          sodium.crypto_aead_chacha20poly1305_ietf_decrypt(
            null,
            pdu,
            null,
            readNonce,
            this.sessionKeys.AccessoryToControllerKey
          )
        );

        decryptedPdus.push(decryptedData);
      } catch (e) {
        // pass
      }
    }

    return decryptedPdus;
  }

  /**
   * Write a series of PDUs to a characteristic.
   *
   * @param {Object} characteristic - Characteristic object to write to
   * @param {Buffer[]} pdus - List of PDUs to send
   * @returns {Promise} Promise which resolves to a list of responses when all
   *                    writes are sent.
   */
  writeCharacteristic(characteristic, pdus) {
    return this._queueOperation(() => {
      const promises = [];

      if (this.sessionKeys) {
        pdus = this._encryptPdus(pdus);
      }

      for (const pdu of pdus) {
        promises.push(
          new Promise((resolve, reject) => {
            characteristic.write(pdu, false, (err) => {
              if (err) {
                reject(err);
              } else {
                resolve();
              }
            });
          })
        );
      }

      return Promise.all(promises).then(() => {
        return this._readCharacteristicInner(characteristic, []);
      });
    });
  }

  /**
   * Read a series of PDUs from a characteristic.
   *
   * @param {Object} characteristic - Characteristic object to write to
   * @param {Buffer[]} pdus - List of PDUs already read
   * @returns {Promise} Promise which resolves to a list of PDUs.
   */
  _readCharacteristicInner(characteristic, pdus = []) {
    return new Promise((resolve, reject) => {
      characteristic.read((err, data) => {
        if (err) {
          reject(err);
        } else if (data && data.length > 0) {
          pdus.push(data);
          resolve(this._readCharacteristicInner(characteristic, pdus));
        } else {
          if (this.sessionKeys) {
            pdus = this._decryptPdus(pdus);
          }

          resolve(pdus);
        }
      });
    });
  }

  /**
   * Read a series of PDUs from a characteristic.
   *
   * @param {Object} characteristic - Characteristic object to write to
   * @returns {Promise} Promise which resolves to a list of PDUs.
   */
  readCharacteristic(characteristic) {
    return this._queueOperation(() => {
      return this._readCharacteristicInner(characteristic, []);
    });
  }
}

module.exports = GattConnection;