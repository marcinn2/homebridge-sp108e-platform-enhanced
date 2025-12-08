/**
 * Porting https://github.com/Lehkeda/SP108E_controller from PHP to JS
 * Porting https://github.com/greenwombat/sp108e from JS to TS
 */
import * as net from 'net';
import colorConvert from 'color-convert';
import { PromiseSocket } from 'promise-socket';
import { ANIMATION_MODE_STATIC, UNKNOWN_MODE } from './animationModes';
import { CHIP_TYPES } from './chipTypes';
import { COLOR_ORDERS } from './colorOrders';
import { Sp108ePlatformAccessory } from '../platformAccessory';

// TODO: find out these values?
const WARM_WHITE = 'ff6717';
const NATURAL_WHITE = '?';
const COLD_WHITE = '?';
const CMD_GET_NAME = '77';
const CMD_SET_CHIP_TYPE = '1c';
const CMD_SET_COLOR_ORDER = '3c';
const CMD_SET_SEGMENTS = '2e';
const CMD_SET_LEDS_PER_SEGMENT = '2d';
const CMD_GET_STATUS = '10';
const CMD_PREFIX = '38';
const CMD_SUFFIX = '83';
const CMD_TOGGLE = 'aa';
const CMD_SET_ANIMATION_MODE = '2c';
const CMD_SET_BRIGHTNESS = '2a'; // Param: 00-FF
const CMD_SET_WHITE_BRIGHTNESS = '08'; // Param: 00-FF
const CMD_SET_SPEED = '03'; // Param: 00-FF
const CMD_SET_COLOR = '22'; // RGB: 000000-FFFFFF
const CMD_SET_DREAM_MODE = '2C'; // Param: 1-180
const CMD_SET_DREAM_MODE_AUTO = '06'; // Param: 00
const CMD_SET_CUSTOM = '02';

const NO_PARAMETER = '000000';

export interface sp108eOptions {
  host: string;
  port: number;
  type?: string;
}

export interface hsv {
  hue: number;
  saturation: number;
  value: number;
}

export interface sp108eStatus {
  rawResponse: string;
  on: boolean;
  animationMode: number;
  presetEffectMode: number;
//  customEffectMode: number;
  animationSpeed: number;
  animationSpeedPercentage: number;
  brightness: number;
  brightnessPercentage: number;
  colorOrder: number;
  ledsPerSegment: number;
  numberOfSegments: number;
  color: string;
  hsv: hsv;
  icType: number;
  recordedPatterns: number;
  whiteBrightness: number;
  whiteBrightnessPercentage: number;
}

export default class sp108e {
  constructor(private readonly options: sp108eOptions, private readonly accessory: Sp108ePlatformAccessory) {
    this.options = options;
    this.accessory = accessory;
  }

  // Persistent socket management
  private _rawSocket?: net.Socket;
  private _client?: PromiseSocket<net.Socket>;
  private _connected = false;
  private _sendQueue: Promise<any> = Promise.resolve();
  private readonly SEND_MAX_RETRIES = 3;
  private readonly SEND_BASE_DELAY_MS = 200;
  private readonly SEND_TIMEOUT_MS = 5000;

  private delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  private async ensureConnected(): Promise<void> {
    if (this._connected && this._client) {
      return;
    }

    // Clean up any previous socket
    try {
      this._rawSocket?.destroy();
    } catch (_) { /* ignore */ }
    this._rawSocket = new net.Socket();
    this._rawSocket.setKeepAlive(true);
    // Attach temporary error/close handlers for this socket instance
    this._rawSocket.on('error', (err) => {
      this.accessory.isDebuggEnabled && this.accessory.platform.log.debug('Socket error ->', err);
      this._connected = false;
      try {
        this._rawSocket?.destroy();
      } catch (_) { /* ignore */ }
      this._client = undefined;
    });

    this._rawSocket.on('close', () => {
      this.accessory.isDebuggEnabled && this.accessory.platform.log.debug('Socket closed');
      this._connected = false;
      this._client = undefined;
    });

    // Connect with a timeout so we don't hang indefinitely
    const connectPromise = new Promise<void>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined = undefined;
      const onConnect = () => {
        cleanup();
        if (timer) {
          clearTimeout(timer);
        }
        resolve();
      };
      const onError = (err: any) => {
        cleanup();
        if (timer) {
          clearTimeout(timer);
        }
        reject(err);
      };
      const onTimeout = () => {
        cleanup();
        try {
          this._rawSocket?.destroy();
        } catch (_) { /* ignore */ }
        reject(new Error('connect timeout'));
      };

      const cleanup = () => {
        this._rawSocket?.removeListener('connect', onConnect);
        this._rawSocket?.removeListener('error', onError);
      };

      this._rawSocket?.once('connect', onConnect);
      this._rawSocket?.once('error', onError);
      this._rawSocket?.connect(this.options.port, this.options.host);

      // enforce connect timeout
      timer = setTimeout(onTimeout, this.SEND_TIMEOUT_MS);
    });

    await connectPromise;
    const client = new PromiseSocket(this._rawSocket);
    this._client = client;
    this._connected = true;
  }

  private _forceDisconnect() {
    try {
      this._rawSocket?.destroy();
    } catch (_) { /* ignore */ }
    this._client = undefined;
    this._connected = false;
  }

  setChipType = async (chipType: string) => {
    const index = CHIP_TYPES.indexOf(chipType);
    if (index === -1) {
      throw new Error('Invalid chip type: ' + chipType);
    }
    return await this.send(CMD_SET_CHIP_TYPE, this.intToHex(index));
  };

  setColorOrder = async (colorOrder: string) => {
    const index = COLOR_ORDERS.indexOf(colorOrder);
    if (index === -1) {
      throw new Error('Invalid color order: ' + colorOrder);
    }
    return await this.send(CMD_SET_COLOR_ORDER, this.intToHex(index));
  };

  setSegments = async (segments: number) => {
    return await this.send(CMD_SET_SEGMENTS, this.intToHex(segments));
  };

  setLedsPerSegment = async (ledsPerSegment: number) => {
    return await this.send(CMD_SET_LEDS_PER_SEGMENT, this.intToHex(ledsPerSegment));
  };

  /**
   * Toggles the led lights on or off
   */
  toggleOnOff = async () => {
    return await this.send(CMD_TOGGLE, NO_PARAMETER, 17);
  };

  /**
   * Toggles the led lights on
   */
  off = async () => {
    const status = await this.getStatus();
    if (status.on) {
      return await this.toggleOnOff();
    }
  };

  /**
   * Toggles the led lights on
   */
  on = async () => {
    const status = await this.getStatus();
    if (!status.on) {
      return await this.toggleOnOff();
    }
  };

  /**
   * Gets the status of the sp108e, on/off, color, etc
   */
  getStatus = async (): Promise<sp108eStatus> => {

    const response = await this.send(CMD_GET_STATUS, NO_PARAMETER, 17);
    const anyMode = parseInt(response.substring(4, 6), 16);
    return {
      rawResponse: response,
      on: response.substring(2, 4) === '01',
      animationMode: anyMode> 180 ? anyMode : UNKNOWN_MODE,
      presetEffectMode: anyMode < 180 ? anyMode : UNKNOWN_MODE,
      animationSpeed: parseInt(response.substring(6, 8), 16),
      animationSpeedPercentage: parseInt(response.substring(6, 8), 16) / 255 * 100,
      brightness: parseInt(response.substring(8, 10), 16),
      brightnessPercentage: parseInt(response.substring(8, 10), 16) / 255 * 100,
      colorOrder: parseInt(response.substring(10, 12), 16),
      ledsPerSegment: parseInt(response.substring(12, 16), 16),
      numberOfSegments: parseInt(response.substring(16, 20), 16),
      color: response.substring(20, 26),
      hsv: this.calculateHsv(response.substring(20, 26)),
      icType: parseInt(response.substring(26, 28), 16),
      recordedPatterns: parseInt(response.substring(28, 30), 16),
      whiteBrightness: parseInt(response.substring(30, 32), 16),
      whiteBrightnessPercentage: parseInt(response.substring(30, 32), 16) / 255 * 100,
    };
  };

  calculateHsv = (hexColor: string): hsv => {
    const hsv = colorConvert.hex.hsv(hexColor);
    return { hue: hsv[0], saturation: hsv[1], value: hsv[2] };
  };

  /**
   * Sets the brightness of the leds
   * @param {integer} brightness any integer from 0-255
   */
  setBrightness = async (brightness: number) => {
    return await this.send(CMD_SET_BRIGHTNESS, this.intToHex(brightness), 0);
  };

  setBrightnessPercentage = async (brightnessPercentage: number) => {
    return await this.setBrightness(Math.ceil(brightnessPercentage / 100 * 255));
  };

  setWhiteBrightness = async (brightness: number) => {
    if (brightness < 1) {
      brightness = 1;
    }
    return await this.send(CMD_SET_WHITE_BRIGHTNESS, this.intToHex(brightness), 0);
  };

  setWhiteBrightnessPercentage = async (brightnessPercentage: number) => {
    return await this.setWhiteBrightness(Math.ceil(brightnessPercentage / 100 * 255));
  };

  /**
   * Sets the color of the leds
   * @param {string} hexColor Hex color without hash. e.g, "FFAABB"
   */
  setColor = async (hexColor: string) => {
    const status = await this.getStatus();
    if (status.animationMode === 0) {
      await this.send(CMD_SET_ANIMATION_MODE, this.intToHex(ANIMATION_MODE_STATIC));
    }
    return await this.send(CMD_SET_COLOR, hexColor, 0);
  };

  /**
   * Sets the animation mode of the leds (for single color mode)
   * @param {number} animationMode Use one of the ANIMATION_MODE_XXXX constants. Defaults to ANIMATION_MODE_STATIC
   */
  setAnimationMode = async (animationMode: number) => {
    return await this.send(CMD_SET_ANIMATION_MODE, this.intToHex(animationMode));
  };

  /**
   * Sets a preset mode (wrapper for animation command scoped to presets)
   * @param {number} presetMode any integer 0-179
   */
  setPresetMode = async (presetMode: number) => {
    const truncated = Math.min(Math.max(presetMode, 0), 179);
    this.accessory.isDebuggEnabled && this.accessory.platform.log.info('set preset mode ->', truncated);
    return await this.send(CMD_SET_DREAM_MODE, this.intToHex(truncated));
  };

  /**
   * Sets the speed of the animation
   * @param {integer} speed any integer 0-255
   */
  setAnimationSpeed = async (speed: number) => {
    return await this.send(CMD_SET_SPEED, this.intToHex(speed), 0);
  };

  setAnimationSpeedPercentage = async (speedPercentage: number) => {
    return await this.setAnimationSpeed(Math.ceil(speedPercentage / 100 * 255));
  };

  intToHex = (int: number | undefined) => {
    const value = int ?? 0;
    return value.toString(16).padStart(2, '0');
  };

  send = async (cmd: string, parameter = NO_PARAMETER, responseLength = 0): Promise<string> => {
    const attemptExecute = async (): Promise<string> => {
      // Ensure persistent connection is established
      await this.ensureConnected();
      if (!this._client) {
        throw new Error('Unable to establish connection');
      }

      const hex = CMD_PREFIX + parameter.padEnd(6, '0') + cmd + CMD_SUFFIX;
      const rawHex = Buffer.from(hex, 'hex');

      try {
        await this._client.write(rawHex);

        if (responseLength > 0) {
          // read with per-operation timeout
          const readPromise = this._client.read(responseLength);
          let t: NodeJS.Timeout | undefined;
          const timeoutPromise = new Promise<never>((_, reject) => {
            t = setTimeout(() => {
              // Force reconnect on timeout
              this._forceDisconnect();
              reject(new Error('send() read timeout'));
            }, this.SEND_TIMEOUT_MS);
          });
          const responseBuf = await Promise.race([readPromise, timeoutPromise]) as Buffer | undefined;
          if (t) {
            clearTimeout(t);
          }
          return responseBuf ? responseBuf.toString('hex') : '';
        }

        // write-only command: small delay to avoid overwhelming device
        await this.sleep();
        return '';
      } catch (err) {
        // On any error, force disconnect so next attempt reconnects
        this._forceDisconnect();
        throw err;
      }
    };

    const executeWithRetries = async (): Promise<string> => {
      let lastErr: any = null;
      for (let attempt = 0; attempt <= this.SEND_MAX_RETRIES; attempt++) {
        try {
          return await attemptExecute();
        } catch (err) {
          lastErr = err;
          // Transient/network errors -> retry with exponential backoff
          if (attempt < this.SEND_MAX_RETRIES) {
            const backoff = this.SEND_BASE_DELAY_MS * Math.pow(2, attempt);
            this.accessory.isDebuggEnabled && this.accessory.platform.log.info('send() failed, retrying after backoff ms ->', backoff, err);
            await this.delay(backoff);
            continue;
          }
          // Exhausted retries
          throw lastErr;
        }
      }
      // Should not reach here
      throw lastErr;
    };

    // Queue execution to ensure only one send() runs at a time
    const queued = this._sendQueue.then(() => executeWithRetries());
    // Keep the queue chain alive even if a request fails
    this._sendQueue = queued.catch((err) => {
      this.accessory.isDebuggEnabled && this.accessory.platform.log.debug('send() queue error ->', err);
    });
    return queued;
  };

  sleep = () => {
    return new Promise((resolve) => setTimeout(resolve, 250));
  };
}