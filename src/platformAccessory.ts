import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import colorConvert from 'color-convert';
import { ANIMATION_MODE_STATIC, ALL_ANIMATION_MODES, PRESET_EFFECTS, PRESET_EFFECT_RAINBOW } from './lib/animationModes';
import { ANIMATION_MODES, UNKNOWN_MODE, ANIMATION_MODE_WAVE } from './lib/animationModes';
import sp108e, { sp108eStatus } from './lib/sp108e';
import { Sp108ePlatform } from './platform';
import { MANUFACTURER, MODEL } from './settings';
import { CHIP_TYPES, RGBW_CHIP_TYPES } from './lib/chipTypes';
import { COLOR_ORDERS } from './lib/colorOrders';

const POLL_INTERVAL = 1000;

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export class Sp108ePlatformAccessory {
  public readonly platform: Sp108ePlatform;
  public readonly isDebuggEnabled: boolean;
  private debug: boolean;

  private rgbOn: boolean;
  private presetEffectNumber: number;
  private animationNumber: number;
  private device: sp108e;
  private rgbService: Service;
  private wService!: Service;
  private asService: Service;
  private mdService: Service;
  private prService!: Service;
  private animationOn!: boolean;

  private lastPull!: Date;
  private deviceStatus!: sp108eStatus;
  private targetHue!: number | undefined;
  private targetSaturation!: number | undefined;
  private presetOn!: boolean;

  constructor(
    platform: Sp108ePlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    this.platform = platform;

    this.debug = accessory.context.device.debug;
    this.isDebuggEnabled = this.debug;
    this.debug ? this.platform.log.warn('Debug is enabled'): this.platform.log.info('Debug is disabled');

    this.rgbOn = false;
    this.presetEffectNumber = accessory.context.device.defaultDreamModeNumber;
    this.animationNumber = accessory.context.device.defaultAnimationNumber;

    // Setting defaultAnimationNumber to STATIC (211) cause problem when switching on animations. It will switch off immediately
    if (this.animationNumber === ANIMATION_MODE_STATIC) {
      this.animationNumber = ANIMATION_MODE_WAVE;
    }

    // Available presets from config (comma-separated string).
    // Convert comma-separated string to array of numbers, ignoring spaces.
    let AVAILABLE_EFECTS: number[] | undefined;
    const availableEffectsConfig = this.accessory.context.device.availableEffects;
    if (typeof availableEffectsConfig === 'string') {
      // Parse comma-separated string: "0, 1, 2, 5, 10" -> [0, 1, 2, 5, 10]
      AVAILABLE_EFECTS = availableEffectsConfig
        .split(',')
        .map(token => {
          const num = parseInt(token.trim(), 10);
          return isNaN(num) ? null : num;
        })
        .filter((num): num is number => num !== null);
    } else if (Array.isArray(availableEffectsConfig)) {
      AVAILABLE_EFECTS = availableEffectsConfig;
    }

    // Helper: check whether a given presetMode is allowed by AVAILABLE_EFECTS.
    // If AVAILABLE_EFECTS is not an array or is empty, treat all presets as allowed.
    const isPresetAllowed = (presetMode: string): boolean => {
      if (!Array.isArray(AVAILABLE_EFECTS) || AVAILABLE_EFECTS.length === 0) {
        return true;
      }
      const idx = Math.floor(Number(presetMode));
      return AVAILABLE_EFECTS.includes(idx);
    };


    this.platform.log.info(accessory.context.device);

    // instantiate sp108e
    this.device = new sp108e(accessory.context.device, this);

    const serialNumberBase = `${accessory.context.device.host}:${accessory.context.device.port}`;

    // set accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Name, accessory.context.device.name)
      .setCharacteristic(this.platform.Characteristic.ConfiguredName, accessory.context.device.name)
      .setCharacteristic(this.platform.Characteristic.Manufacturer, MANUFACTURER)
      .setCharacteristic(this.platform.Characteristic.Model, MODEL)
      .setCharacteristic(this.platform.Characteristic.SerialNumber, serialNumberBase);
    this.accessory.category = this.platform.api.hap.Categories.LIGHTBULB;


    // rgb led
    const rgbServiceName = accessory.context.device.name + ' Color';
    this.rgbService = this.accessory.getService(rgbServiceName) ||
      this.accessory.addService(this.platform.Service.Lightbulb, rgbServiceName, `${serialNumberBase}/rgb`);

    this.rgbService.getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.setOn.bind(this));


    this.rgbService.getCharacteristic(this.platform.Characteristic.Brightness)
      .onSet(this.setBrightness.bind(this));

    this.rgbService
      .getCharacteristic(this.platform.Characteristic.Hue)
      .onSet(this.setHue.bind(this));

    this.rgbService
      .getCharacteristic(this.platform.Characteristic.Saturation)
      .onSet(this.setSaturation.bind(this));

    // white led
    if (RGBW_CHIP_TYPES.includes(accessory.context.device?.chip)) {
      const wServiceName = accessory.context.device.name + ' White';
      this.wService = this.accessory.getService(wServiceName) ||
        this.accessory.addService(this.platform.Service.Lightbulb, wServiceName, `${serialNumberBase}/w`);

      this.wService.getCharacteristic(this.platform.Characteristic.Brightness)
        .onSet(this.setWhiteBrightness.bind(this));
    }

    // animation speed
    const asServicename = accessory.context.device.name + ' Animation Speed';
    this.asService = this.accessory.getService(asServicename) ||
      this.accessory.addService(this.platform.Service.Fanv2, asServicename, `${serialNumberBase}/as`);

    this.asService
      .setCharacteristic(this.platform.Characteristic.ConfiguredName, asServicename)
      .setCharacteristic(this.platform.Characteristic.SleepDiscoveryMode,
        this.platform.Characteristic.SleepDiscoveryMode.ALWAYS_DISCOVERABLE);


    this.asService
      .getCharacteristic(this.platform.Characteristic.Active)
      .onSet(this.setAnimationSpeedOn.bind(this));

    this.asService
      .getCharacteristic(this.platform.Characteristic.RotationSpeed)
      .onSet(this.setAnimationSpeed.bind(this));


    // Remove old input services that might have wrong subtypes
    const existingInputs = this.accessory.services.filter(
      service => service.UUID === this.platform.Service.InputSource.UUID,
    );
    existingInputs.forEach(service => {
      this.accessory.removeService(service);
    });

    // adnimation mode
    const mdServiceName = accessory.context.device.name + ' Animation Mode';
    this.mdService = this.accessory.getService(mdServiceName) ||
      this.accessory.addService(this.platform.Service.Television, mdServiceName, `${serialNumberBase}/md`);

    // Configure TV service
    this.mdService
      .setCharacteristic(this.platform.Characteristic.ConfiguredName, mdServiceName)
      .setCharacteristic(this.platform.Characteristic.SleepDiscoveryMode,
        this.platform.Characteristic.SleepDiscoveryMode.ALWAYS_DISCOVERABLE);

    this.mdService
      .getCharacteristic(this.platform.Characteristic.Active)
      .onSet(this.setAnimationModeOn.bind(this));

    this.mdService
      .getCharacteristic(this.platform.Characteristic.ActiveIdentifier)
      .onSet(this.setAnimationMode.bind(this));

    const animationModes = Object.entries({ ...ANIMATION_MODES });
    for (const [animationMode, animationModeName] of animationModes) {

      //TODO remove this condition when animationModeOn is removed
      if (animationMode === ANIMATION_MODE_STATIC.toString()) {
        continue;
      }

      const mdInputServiceName = `${animationModeName} MD`;
      const mdInputServiceSubtype = `${serialNumberBase}/md/${animationMode}`;

      const animationModeInputSource = this.accessory.getService(mdInputServiceName) ||
        this.accessory.addService(this.platform.Service.InputSource, mdInputServiceName, mdInputServiceSubtype);

      animationModeInputSource
        .setCharacteristic(this.platform.api.hap.Characteristic.Identifier, parseInt(animationMode))
        .setCharacteristic(this.platform.api.hap.Characteristic.ConfiguredName, animationModeName)
        .setCharacteristic(this.platform.api.hap.Characteristic.IsConfigured, this.platform.api.hap.Characteristic.IsConfigured.CONFIGURED)
        .setCharacteristic(this.platform.api.hap.Characteristic.InputSourceType, this.platform.api.hap.Characteristic.InputSourceType.HDMI);

      this.mdService.addLinkedService(animationModeInputSource);
    }

    // Duplicate mdService as prService (preset modes) with separate InputSource instances
    const prServiceName = accessory.context.device.name + ' Preset Mode';
    this.prService = this.accessory.getService(prServiceName) ||
      this.accessory.addService(this.platform.Service.Television, prServiceName, `${serialNumberBase}/pr`);

    // Configure TV service
    this.prService
      .setCharacteristic(this.platform.Characteristic.ConfiguredName, prServiceName)
      .setCharacteristic(this.platform.Characteristic.SleepDiscoveryMode,
        this.platform.Characteristic.SleepDiscoveryMode.ALWAYS_DISCOVERABLE);

    this.prService
      .getCharacteristic(this.platform.Characteristic.Active)
      .onSet(this.setPresetModeOn.bind(this));

    this.prService
      .getCharacteristic(this.platform.Characteristic.ActiveIdentifier)
      .onSet(this.setPresetMode.bind(this));
    this.prService.setCharacteristic(this.platform.api.hap.Characteristic.Name, 'Preset Mode');


    // Create separate InputSource services for prService using PRESET_EFFECTS
    const presetModes = Object.entries({ ...PRESET_EFFECTS });
    let createdPresetCount = 0;
    for (const [presetMode, presetModeName] of presetModes) {

      // If AVAILABLE_EFECTS is not provided, limit created InputSource services to the first 50 presets
      if ((!Array.isArray(AVAILABLE_EFECTS) || AVAILABLE_EFECTS.length === 0) && createdPresetCount >= 50) {
        break;
      }

      const prInputServiceName = `${presetModeName} PR`;
      const prInputServiceSubtype = `${serialNumberBase}/pr/${presetMode}`;

      if (!isPresetAllowed(presetMode as string)) {
        this.platform.log.info('Preset not allowed by config ->', presetMode);
        continue;
      }

      const presetModeInputSource = this.accessory.getService(prInputServiceName) ||
        this.accessory.addService(this.platform.Service.InputSource, prInputServiceName, prInputServiceSubtype);

      presetModeInputSource
        .setCharacteristic(this.platform.api.hap.Characteristic.Identifier, parseInt(presetMode))
        .setCharacteristic(this.platform.api.hap.Characteristic.ConfiguredName, presetModeName)
        .setCharacteristic(this.platform.api.hap.Characteristic.IsConfigured, this.platform.api.hap.Characteristic.IsConfigured.CONFIGURED)
        .setCharacteristic(this.platform.api.hap.Characteristic.InputSourceType, this.platform.api.hap.Characteristic.InputSourceType.HDMI);

      this.prService.addLinkedService(presetModeInputSource);
      createdPresetCount++;
    }

    this.initialize(accessory.context.device);
    this.sync();
  }

  async initialize({ chip, colorOrder, segments, ledsPerSegment }) {
    this.animationOn = false;
    this.presetOn = false;

    await this.pollStatus();
    if (typeof this.deviceStatus === 'undefined') {
      this.platform.log.error('Unable to poll status during initialization');
      return;
    }

    const chipIndex = CHIP_TYPES.indexOf(chip);
    if (this.deviceStatus?.icType !== chipIndex) {
      this.debug && this.platform.log.info('setting chip type ->', chip);
      await this.device.setChipType(chip);
    }

    const colorOrderIndex = COLOR_ORDERS.indexOf(colorOrder);
    if (this.deviceStatus?.colorOrder !== colorOrderIndex) {
      this.debug && this.platform.log.info('setting color order ->', colorOrder);
      await this.device.setColorOrder(colorOrder);
    }

    if (this.deviceStatus?.numberOfSegments !== segments) {
      this.debug && this.platform.log.info('setting segments ->', segments);
      await this.device.setSegments(segments);
    }

    if (this.deviceStatus?.ledsPerSegment !== ledsPerSegment) {
      this.debug && this.platform.log.info('setting LEDs per segment ->', ledsPerSegment);
      await this.device.setLedsPerSegment(ledsPerSegment);
    }
  }

  sync() {
    setInterval(async () => {
      await this.pollStatus();
    }, POLL_INTERVAL);
  }

  async pollStatus() {
    try {
      this.deviceStatus = await this.device.getStatus();
      this.lastPull = new Date();

      this.rgbOn = this.deviceStatus.on;

      const tmpAMode: number = this.deviceStatus.animationMode;

      const animationModeOn = tmpAMode !== ANIMATION_MODE_STATIC && tmpAMode !== UNKNOWN_MODE && this.deviceStatus.on ?
        this.platform.api.hap.Characteristic.Active.ACTIVE :
        this.platform.api.hap.Characteristic.Active.INACTIVE;

      if (tmpAMode !== ANIMATION_MODE_STATIC && tmpAMode !== UNKNOWN_MODE && this.deviceStatus.on) {
        if (typeof ANIMATION_MODES[this.deviceStatus.animationMode] !== 'undefined') {
          this.animationNumber = this.deviceStatus.animationMode;
          this.debug && this.platform.log.info('Value of animationNumber is correct ->', this.animationNumber);
        } else {
          this.debug && this.platform.log.info('Value of animationNumber is not in ANIMATION_MODES');
        }
      } else {
        this.debug &&
        this.platform.log.info('State of animationNumber is unknown or device off ->', this.deviceStatus.on);
      }

      const presetModeOn = this.deviceStatus.presetEffectMode !== UNKNOWN_MODE && this.deviceStatus.on ?
        this.platform.api.hap.Characteristic.Active.ACTIVE :
        this.platform.api.hap.Characteristic.Active.INACTIVE;

      if (this.deviceStatus.presetEffectMode !== UNKNOWN_MODE && this.deviceStatus.on) {
        if (typeof PRESET_EFFECTS[this.deviceStatus.presetEffectMode] !== 'undefined') {
          this.presetEffectNumber = this.deviceStatus.presetEffectMode;
          this.debug && this.platform.log.info('Value of presetEffectMode ->', this.presetEffectNumber);
        } else {
          this.debug &&
          this.platform.log.info('Value of presetEffectMode -> ', this.deviceStatus.presetEffectMode, ' not in PRESET_EFFECTS');
        }
      } else {
        this.debug && this.platform.log.info('State of presetEffectMode is unknown or device off ->', this.deviceStatus.on);
      }

      // rgbService
      this.rgbService.updateCharacteristic(this.platform.Characteristic.On, this.rgbOn);
      this.debug && this.platform.log.info('Update Characteristic On ->', this.rgbOn);

      if (this.rgbOn) {
        // Fix: Homebridge expects a valid finite number for Brightness, fallback to 0 if NaN
        let safeBrightness = this.deviceStatus.brightnessPercentage;
        if (typeof safeBrightness !== 'number' || !isFinite(safeBrightness) || isNaN(safeBrightness)) {
          safeBrightness = 0;
        }
        this.rgbService.updateCharacteristic(this.platform.Characteristic.Brightness, safeBrightness);
        this.debug && this.platform.log.info('Update Characteristic Brightness ->', safeBrightness);
      } else {
        this.rgbService.updateCharacteristic(this.platform.Characteristic.Brightness, 0);
        this.debug && this.platform.log.info('Update Characteristic Brightness ->', 0);
      }

      this.rgbService.updateCharacteristic(this.platform.Characteristic.Hue, this.deviceStatus.hsv.hue);
      this.debug && this.platform.log.info('Update Characteristic Hue ->', this.deviceStatus.hsv.hue);

      this.rgbService.updateCharacteristic(this.platform.Characteristic.Saturation, this.deviceStatus.hsv.saturation);
      this.debug && this.platform.log.info('Update Characteristic Saturation ->', this.deviceStatus.hsv.saturation);

      // wService
      if (this.wService) {
        // Fix: Homebridge expects a valid finite number for Brightness, fallback to 0 if NaN
        let safeWhiteBrightness = this.deviceStatus.whiteBrightnessPercentage;
        if (typeof safeWhiteBrightness !== 'number' || !isFinite(safeWhiteBrightness) || isNaN(safeWhiteBrightness)) {
          safeWhiteBrightness = 0;
        }
        this.wService.updateCharacteristic(this.platform.Characteristic.Brightness, safeWhiteBrightness);
        this.debug && this.platform.log.info('Update Characteristic Brightness of w ->', safeWhiteBrightness);
      }

      // asService
      this.asService.updateCharacteristic(this.platform.Characteristic.Active, animationModeOn);
      this.debug && this.platform.log.info('Update Characteristic Active of as ->', animationModeOn);

      // Fix: Homebridge expects a valid finite number for RotationSpeed, fallback to 0 if NaN
      let safeRotationSpeed = this.deviceStatus.animationSpeedPercentage;
      if (typeof safeRotationSpeed !== 'number' || !isFinite(safeRotationSpeed) || isNaN(safeRotationSpeed)) {
        safeRotationSpeed = 0;
      }
      this.asService.updateCharacteristic(this.platform.Characteristic.RotationSpeed, safeRotationSpeed);
      this.debug && this.platform.log.info('Update Characteristic RotationSpeed of as ->', safeRotationSpeed);

      // mdService
      this.mdService.updateCharacteristic(this.platform.Characteristic.Active, animationModeOn);
      this.debug && this.platform.log.info('Update Characteristic Active of md ->', animationModeOn);

      if (this.animationNumber !== UNKNOWN_MODE) {
        let safeActiveIdentifier = this.animationNumber;
        if (typeof safeActiveIdentifier !== 'number' || !isFinite(safeActiveIdentifier) || isNaN(safeActiveIdentifier)) {
          safeActiveIdentifier = ANIMATION_MODE_STATIC;
        }
        this.mdService.updateCharacteristic(this.platform.Characteristic.ActiveIdentifier, safeActiveIdentifier);
        this.debug && this.platform.log.info('Update Characteristic ActiveIdentifier of md ->', safeActiveIdentifier);
      }

      if (this.prService ) {
        this.prService.updateCharacteristic(this.platform.Characteristic.Active, presetModeOn);
        this.debug && this.platform.log.info('Update Characteristic Active of pr ->', presetModeOn);

        // prService (preset) mirrors mdService state
        if ( this.presetEffectNumber !== UNKNOWN_MODE) {
          let safeIdentifier = this.presetEffectNumber;
          if (typeof safeIdentifier !== 'number' || !isFinite(safeIdentifier) || isNaN(safeIdentifier)) {
            safeIdentifier = PRESET_EFFECT_RAINBOW;
          }
          this.prService.updateCharacteristic(this.platform.Characteristic.ActiveIdentifier, safeIdentifier);
          this.debug && this.platform.log.info('Update Characteristic ActiveIdentifier of pr ->', safeIdentifier);
        }
      }
    } catch (e) {
      this.platform.log.error('Pull error ->', e);
    }
  }

  isOutOfSync() {
    return this.deviceStatus === undefined ||
      this.lastPull === undefined ||
      (new Date().getUTCMilliseconds()) - this.lastPull.getUTCMilliseconds() > POLL_INTERVAL;
  }

  async setOn(value: CharacteristicValue) {
    try {
      // Sync device status
      await this.device.getStatus();

      if (Boolean(value) === true) {
        this.platform.log.info('Settings device ON');
        // Set device on
        await this.device.on();
      } else {
        this.platform.log.info('Settings device OFF');
        // Set device off
        await this.device.off();
      }
      // Sync local rgb status
      this.rgbOn = Boolean(value);
      if (!this.rgbOn) {
        this.animationOn = false;
        this.presetOn = false;
      }
    } catch (e) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  async setBrightness(value: CharacteristicValue) {
    try {
      if (!this.deviceStatus.on) {
        await this.device.on();
      }


      // From a generic value (CharacteristicValue) to integer with validation:
      const n = Number(value);
      let i = 0;
      if (!Number.isFinite(n) || Number.isNaN(n)) {
        await this.device.off();
      } else {
        i = Math.trunc(n);
        if ( i <1 ) {
          i = 0;
          await this.device.off();
          return;
        }
        await this.device.setBrightnessPercentage(i as number);
      }

      this.platform.log.info('Set Characteristic Brightness truncated to ->', i);
    } catch (e) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  async setColor() {
    const colorHex = colorConvert.hsv.hex([this.targetHue as number, this.targetSaturation as number, this.deviceStatus.hsv.value]);
    this.debug && this.platform.log.info('Converted color from HSV to HEX ->', { h: this.targetHue, s: this.targetSaturation }, colorHex);
    await this.device.setColor(colorHex);
    this.targetHue = undefined;
    this.targetSaturation = undefined;
  }

  async setHue(value: CharacteristicValue) {
    try {
      this.debug && this.platform.log.info('Set Characteristic Hue ->', value);
      this.targetHue = value as number;

      if (this.targetSaturation === undefined) {
        return;
      }

      await this.setColor();
    } catch (e) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  async setSaturation(value: CharacteristicValue) {
    try {
      this.debug && this.platform.log.info('Set Characteristic Saturation ->', value);
      this.targetSaturation = value as number;

      if (this.targetHue === undefined) {
        return;
      }

      await this.setColor();
    } catch (e) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  async setWhiteBrightness(value: CharacteristicValue) {
    try {
      await this.device.setWhiteBrightnessPercentage(value as number);

      this.debug && this.platform.log.info('Set Characteristic Brightness of w ->', value);
    } catch (e) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  async setAnimationSpeedOn(value: CharacteristicValue) {
    try {
      if (this.deviceStatus.animationMode !== UNKNOWN_MODE && this.deviceStatus.animationMode !== ANIMATION_MODE_STATIC) {
        await this.setAnimationModeOn(value);
      } else if (this.deviceStatus.presetEffectMode !== UNKNOWN_MODE) {
        await this.setPresetModeOn(value);
      } else {
        await this.setAnimationModeOn(value);
      }
    } catch (e) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  async setAnimationSpeed(value: CharacteristicValue) {
    try {
      await this.device.setAnimationSpeedPercentage(value as number);

      this.debug && this.platform.log.info('Set Characteristic RotationSpeed of as ->', value);
    } catch (e) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  async setAnimationModeOn(value: CharacteristicValue) {
    try {
      this.debug && this.platform.log.info(
        'Checking whether Characteristic Active of as/md should be changed',
        value,
        this.deviceStatus.animationMode,
        this.animationOn,
      );
      if (value && this.deviceStatus.animationMode !== ANIMATION_MODE_STATIC && this.animationOn === true) {
        this.debug && this.platform.log.info('Characteristic Active of as/md is already ->', value);
        return;
      }
      if (!value && this.deviceStatus.animationMode === ANIMATION_MODE_STATIC && this.animationOn === false) {
        this.debug && this.platform.log.info('Characteristic Active of as/md is already ->', value);
        return;
      }

      if (!this.deviceStatus.on) {
        await this.device.on();
      }

      this.animationOn = Boolean(value);

      let currentAnnimationMode = UNKNOWN_MODE;
      if ( this.animationOn) {
        currentAnnimationMode = this.deviceStatus.animationMode !== UNKNOWN_MODE
          ? this.deviceStatus.animationMode : this.animationNumber;
        // if (currentAnnimationMode === ANIMATION_MODE_STATIC) {
        //   currentAnnimationMode = ANIMATION_MODE_FLOW;
        // }
        if (typeof ANIMATION_MODES[currentAnnimationMode] === 'undefined') {
          currentAnnimationMode = ANIMATION_MODE_WAVE;
        }
        if (currentAnnimationMode !== ANIMATION_MODE_STATIC) {
          this.animationNumber = currentAnnimationMode;
          this.deviceStatus.animationMode - currentAnnimationMode;
        }
      }

      value
        ? this.device.setAnimationMode(this.animationNumber)
        : this.device.setAnimationMode(ANIMATION_MODE_STATIC);

      this.debug && this.platform.log.info('Set Characteristic Active of as/md/pr ->', value);
    } catch (e) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  async setAnimationMode(value: CharacteristicValue) {
    try {
      this.platform.log.info('Checking animation mode', value, value.toString(), ALL_ANIMATION_MODES[value.toString()]);

      if (!this.deviceStatus.on) {
        await this.device.on();
      }

      if (typeof ANIMATION_MODES[value.toString()] === 'undefined') {
        await this.device.setAnimationMode(ANIMATION_MODE_STATIC);
      } else {
        await this.device.setAnimationMode(value as number);
      }

      this.debug && this.platform.log.info('Set Characteristic ActiveIdentifier of md ->', value);
    } catch (e) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  async setPresetModeOn(value: CharacteristicValue) {
    try {
      this.debug && this.platform.log.info(
        'Checking whether Characteristic Active of pr should be changed',
        value,
        this.deviceStatus.presetEffectMode,
        this.presetOn,
      );

      if (value && this.deviceStatus.presetEffectMode !== UNKNOWN_MODE && this.presetOn === true) {
        this.debug && this.platform.log.info('Characteristic Active of pr is already ->', value);
        return;
      }
      if (!value && this.deviceStatus.presetEffectMode === UNKNOWN_MODE && this.presetOn === false) {
        this.debug && this.platform.log.info('Characteristic Active of pr is already ->', value);
        return;
      }

      if (!this.deviceStatus.on) {
        await this.device.on();
      }

      this.presetOn = Boolean(value);

      if (this.presetOn) {
        let currentPresetMode = UNKNOWN_MODE;
        currentPresetMode = this.deviceStatus.presetEffectMode !== UNKNOWN_MODE
          ? this.deviceStatus.presetEffectMode : this.presetEffectNumber;

        // if (typeof PRESET_EFFECTS[currentPresetMode] !== 'undefined') {
        //   currentPresetMode = PRESET_EFFECT_RAINBOW;
        // }
        this.presetEffectNumber = currentPresetMode;
        this.deviceStatus.presetEffectMode = currentPresetMode;
        this.debug && this.platform.log.info('Current preset mode ->', this.presetEffectNumber);
      }

      value
        ? this.device.setPresetMode(this.presetEffectNumber)
        : this.device.setAnimationMode(ANIMATION_MODE_STATIC);

      this.debug && this.platform.log.info('Set Characteristic Active of pr ->', value);
    } catch (e) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }



  async setPresetMode(value: CharacteristicValue) {
    try {
      const truncValue = (value as number) % 180 as CharacteristicValue;
      this.platform.log.info('Checking preset mode', value, truncValue.toString(), PRESET_EFFECTS[truncValue.toString()]);

      if (!this.deviceStatus.on) {
        await this.device.on();
      }

      if (typeof PRESET_EFFECTS[truncValue.toString()] === 'undefined') {
        // If preset not found, fallback to rainbow mode
        await this.device.setPresetMode(PRESET_EFFECT_RAINBOW);
      } else {
        // Use device.setPresetMode to apply preset (does not call accessory-level setAnimationMode)
        await this.device.setPresetMode(truncValue as number);
      }

      this.debug && this.platform.log.info('Set Characteristic ActiveIdentifier of pr ->', truncValue);
    } catch (e) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }
}