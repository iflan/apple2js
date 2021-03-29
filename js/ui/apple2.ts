import MicroModal from 'micromodal';

import { base64_json_parse, base64_json_stringify } from '../base64';
import Audio from './audio';
import DriveLights from './drive_lights';
import { byte, DISK_FORMATS, includes, word } from '../types';
import { gamepad, configGamepad, initGamepad, GamepadConfiguration } from './gamepad';
import KeyBoard from './keyboard';
import Tape, { TAPE_TYPES } from './tape';

import ApplesoftDump from '../applesoft/decompiler';
import ApplesoftCompiler from '../applesoft/compiler';

import { debug, gup, hup } from '../util';
import Prefs from '../prefs';
import { Apple2, Stats } from '../apple2';
import DiskII, { DriveNumber, DRIVE_NUMBERS } from '../cards/disk2';
import SmartPort from '../cards/smartport';
import CPU6502 from '../cpu6502';
import { VideoModes } from '../videomodes';
import Apple2IO from '../apple2io';
import { JSONDisk } from '../formats/format_utils';
import Printer from './printer';

let paused = false;

let focused = false;
let startTime = Date.now();
let lastCycles = 0;
let lastFrames = 0;
let lastRenderedFrames = 0;

let hashtag = document.location.hash;

interface DiskDescriptor {
    name: string;
    disk?: number;
    filename: string;
    e?: boolean;
    category: string;
}

type DiskCollection = {
    [name: string]: DiskDescriptor[]
};

const disk_categories: DiskCollection = { 'Local Saves': [] };
const disk_sets: DiskCollection = {};
// Disk names
const disk_cur_name: string[] = [];
// Disk categories
const disk_cur_cat: string[] = [];

let _apple2: Apple2;
let cpu: CPU6502;
let stats: Stats;
let vm: VideoModes;
let tape: Tape;
let _disk2: DiskII;
let _smartPort: SmartPort;
let _printer: Printer;
let audio: Audio;
let keyboard: KeyBoard;
let io: Apple2IO;
let _currentDrive: DriveNumber = 1;

export const driveLights = new DriveLights();

export function dumpAppleSoftProgram() {
    const dumper = new ApplesoftDump(cpu);
    debug(dumper.toString());
}

export function compileAppleSoftProgram(program: string) {
    const compiler = new ApplesoftCompiler(cpu);
    compiler.compile(program);
}

export function openLoad(driveString: string, event: MouseEvent) {
    const drive = parseInt(driveString, 10);
    if (event.metaKey && includes(DRIVE_NUMBERS, drive)) {
        openLoadHTTP(drive);
    } else {
        if (disk_cur_cat[drive]) {
            const element = document.querySelector<HTMLSelectElement>('#category_select')!;
            element.value = disk_cur_cat[drive];
            selectCategory();
        }
        MicroModal.show('load-modal');
    }
}

export function openSave(driveString: string, event: MouseEvent) {
    const drive = parseInt(driveString, 10) as DriveNumber;

    const mimeType = 'application/octet-stream';
    const data = _disk2.getBinary(drive);
    const a = document.querySelector<HTMLAnchorElement>('#local_save_link')!;

    if (!data) {
        alert('No data from drive ' + drive);
        return;
    }

    const blob = new Blob([data], { 'type': mimeType });
    a.href = window.URL.createObjectURL(blob);
    a.download = driveLights.label(drive) + '.dsk';

    if (event.metaKey) {
        dumpDisk(drive);
    } else {
        const saveName = document.querySelector<HTMLInputElement>('#save_name')!;
        saveName.value = driveLights.label(drive);
        MicroModal.show('save-modal');
    }
}

export function openAlert(msg: string) {
    const el = document.querySelector<HTMLDivElement>('#alert-modal .message')!;
    el.innerText = msg;
    MicroModal.show('alert-modal');
}

/********************************************************************
 *
 * Drag and Drop
 */

export function handleDragOver(_drive: number, event: DragEvent) {
    event.preventDefault();
    event.dataTransfer!.dropEffect = 'copy';
}

export function handleDragEnd(_drive: number, event: DragEvent) {
    const dt = event.dataTransfer!;
    if (dt.items) {
        for (let i = 0; i < dt.items.length; i++) {
            dt.items.remove(i);
        }
    } else {
        dt.clearData();
    }
}

export function handleDrop(drive: number, event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();

    if (drive < 1) {
        if (!_disk2.getMetadata(1)) {
            drive = 1;
        } else if (!_disk2.getMetadata(2)) {
            drive = 2;
        } else {
            drive = 1;
        }
    }
    const dt = event.dataTransfer!;
    if (dt.files.length == 1) {
        const runOnLoad = event.shiftKey;
        doLoadLocal(drive as DriveNumber, dt.files[0], { runOnLoad });
    } else if (dt.files.length == 2) {
        doLoadLocal(1, dt.files[0]);
        doLoadLocal(2, dt.files[1]);
    } else {
        for (let idx = 0; idx < dt.items.length; idx++) {
            if (dt.items[idx].type === 'text/uri-list') {
                dt.items[idx].getAsString(function (url) {
                    const parts = document.location.hash.split('|');
                    parts[drive - 1] = url;
                    document.location.hash = parts.join('|');
                });
            }
        }
    }
}

function loadingStart() {
    const meter = document.querySelector<HTMLDivElement>('#loading-modal .meter')!;
    meter.style.display = 'none';
    MicroModal.show('loading-modal');
}

function loadingProgress(current: number, total: number) {
    if (total) {
        const meter = document.querySelector<HTMLDivElement>('#loading-modal .meter')!;
        const progress = document.querySelector<HTMLDivElement>('#loading-modal .progress')!;
        meter.style.display = 'block';
        progress.style.width = current / total * meter.clientWidth + 'px';
    }
}

function loadingStop() {
    MicroModal.close('loading-modal');

    if (!paused) {
        vm.ready.then(() => {
            _apple2.run();
        });
    }
}

interface JSONBinaryImage {
    type: 'binary',
    start: word,
    length: word,
    data: byte[],
    gamepad?: GamepadConfiguration,
}

export function loadAjax(drive: DriveNumber, url: string) {
    loadingStart();

    fetch(url).then(function (response: Response) {
        if (response.ok) {
            return response.json();
        } else {
            throw new Error('Error loading: ' + response.statusText);
        }
    }).then(function (data: JSONDisk | JSONBinaryImage) {
        if (data.type === 'binary') {
            loadBinary(data as JSONBinaryImage);
        } else if (includes(DISK_FORMATS, data.type)) {
            loadDisk(drive, data);
        }
        initGamepad(data.gamepad);
        loadingStop();
    }).catch(function (error) {
        loadingStop();
        openAlert(error.message);
    });
}

export function doLoad() {
    MicroModal.close('load-modal');
    const select = document.querySelector<HTMLSelectElement>('#disk_select')!;
    const urls = select.value;
    let url;
    if (urls && urls.length) {
        if (typeof (urls) == 'string') {
            url = urls;
        } else {
            url = urls[0];
        }
    }

    const localFile = document.querySelector<HTMLInputElement>('#local_file')!;
    const files = localFile.files;
    if (files && files.length == 1) {
        doLoadLocal(_currentDrive, files[0]);
    } else if (url) {
        let filename;
        MicroModal.close('load-modal');
        if (url.substr(0, 6) == 'local:') {
            filename = url.substr(6);
            if (filename == '__manage') {
                openManage();
            } else {
                loadLocalStorage(_currentDrive, filename);
            }
        } else {
            const r1 = /json\/disks\/(.*).json$/.exec(url);
            if (r1) {
                filename = r1[1];
            } else {
                filename = url;
            }
            const parts = document.location.hash.split('|');
            parts[_currentDrive - 1] = filename;
            document.location.hash = parts.join('|');
        }
    }
}

export function doSave() {
    const saveName = document.querySelector<HTMLInputElement>('#save_name')!;
    const name = saveName.value;
    saveLocalStorage(_currentDrive, name);
    MicroModal.close('save-modal');
    window.setTimeout(() => openAlert('Saved'), 0);
}

export function doDelete(name: string) {
    if (window.confirm('Delete ' + name + '?')) {
        deleteLocalStorage(name);
    }
}

const CIDERPRESS_EXTENSION = /#([0-9a-f]{2})([0-9a-f]{4})$/i;
const BIN_TYPES = ['bin'];

interface LoadOptions {
    address: word,
    runOnLoad?: boolean,
}

function doLoadLocal(drive: DriveNumber, file: File, options: Partial<LoadOptions> = {}) {
    const parts = file.name.split('.');
    const ext = parts[parts.length - 1].toLowerCase();
    const matches = file.name.match(CIDERPRESS_EXTENSION);
    let type, aux;
    if (matches && matches.length === 3) {
        [, type, aux] = matches;
    }
    if (includes(DISK_FORMATS, ext)) {
        doLoadLocalDisk(drive, file);
    } else if (includes(TAPE_TYPES, ext)) {
        tape.doLoadLocalTape(file);
    } else if (BIN_TYPES.includes(ext) || type === '06' || options.address) {
        doLoadBinary(file, { address: parseInt(aux || '2000', 16), ...options });
    } else {
        openAlert('Unknown file type: ' + ext);
    }
}

function doLoadBinary(file: File, options: LoadOptions) {
    loadingStart();

    const fileReader = new FileReader();
    fileReader.onload = function () {
        const result = this.result as ArrayBuffer;
        let { address } = options;
        const bytes = new Uint8Array(result);
        for (let idx = 0; idx < result.byteLength; idx++) {
            cpu.write(address >> 8, address & 0xff, bytes[idx]);
            address++;
        }
        if (options.runOnLoad) {
            cpu.reset();
            cpu.setPC(options.address);
        }
        loadingStop();
    };
    fileReader.readAsArrayBuffer(file);
}

function doLoadLocalDisk(drive: DriveNumber, file: File) {
    loadingStart();
    const fileReader = new FileReader();
    fileReader.onload = function () {
        const result = this.result as ArrayBuffer;
        const parts = file.name.split('.');
        const ext = parts.pop()!.toLowerCase();
        const name = parts.join('.');

        // Remove any json file reference
        const files = document.location.hash.split('|');
        files[drive - 1] = '';
        document.location.hash = files.join('|');

        if (result.byteLength >= 800 * 1024) {
            if (_smartPort.setBinary(drive, name, ext, result)) {
                focused = false;
                initGamepad();
            }
        } else {
            if (includes(DISK_FORMATS, ext)
                && _disk2.setBinary(drive, name, ext, result)) {
                focused = false;
                initGamepad();
            } else {
                openAlert(`Unable to load ${name}`);
            }
        }
        loadingStop();
    };
    fileReader.readAsArrayBuffer(file);
}

export function doLoadHTTP(drive: DriveNumber, url?: string) {
    if (!url) {
        MicroModal.close('http-modal');
    }

    loadingStart();
    const input = document.querySelector<HTMLInputElement>('#http_url')!;
    url = url || input.value;
    if (url) {
        fetch(url).then(function (response) {
            if (response.ok) {
                const reader = response!.body!.getReader();
                let received = 0;
                const chunks: Uint8Array[] = [];
                const contentLength = parseInt(response.headers.get('content-length')!, 10);

                return reader.read().then(
                    function readChunk(result): Promise<ArrayBufferLike> {
                        if (result.done) {
                            const data = new Uint8Array(received);
                            let offset = 0;
                            for (let idx = 0; idx < chunks.length; idx++) {
                                data.set(chunks[idx], offset);
                                offset += chunks[idx].length;
                            }
                            return Promise.resolve(data.buffer);
                        }

                        received += result.value.length;
                        if (contentLength) {
                            loadingProgress(received, contentLength);
                        }
                        chunks.push(result.value);

                        return reader.read().then(readChunk);
                    });
            } else {
                throw new Error('Error loading: ' + response.statusText);
            }
        }).then(function (data) {
            const urlParts = url!.split('/');
            const file = urlParts.pop()!;
            const fileParts = file.split('.');
            const ext = fileParts.pop()!.toLowerCase();
            const name = decodeURIComponent(fileParts.join('.'));
            if (data.byteLength >= 800 * 1024) {
                if (_smartPort.setBinary(drive, name, ext, data)) {
                    initGamepad();
                }
            } else {
                if (includes(DISK_FORMATS, ext)
                    && _disk2.setBinary(drive, name, ext, data)) {
                    initGamepad();
                } else {
                    throw new Error(`Extension ${ext} not recognized.`);
                }
            }
            loadingStop();
        }).catch(function (error) {
            loadingStop();
            openAlert(error.message);
        });
    }
}

function openLoadHTTP(drive: DriveNumber) {
    _currentDrive = drive;
    MicroModal.show('http-modal');
}

function openManage() {
    MicroModal.show('manage-modal');
}

const prefs = new Prefs();
let showStats = 0;

export function updateKHz() {
    const now = Date.now();
    const ms = now - startTime;
    const cycles = cpu.getCycles();
    let delta;
    let fps;
    let khz;

    const kHzElement = document.querySelector<HTMLDivElement>('#khz')!;
    switch (showStats) {
        case 0: {
            delta = cycles - lastCycles;
            khz = Math.trunc(delta / ms);
            kHzElement.innerText = khz + ' kHz';
            break;
        }
        case 1: {
            delta = stats.renderedFrames - lastRenderedFrames;
            fps = Math.trunc(delta / (ms / 1000));
            kHzElement.innerText = fps + ' rps';
            break;
        }
        default: {
            delta = stats.frames - lastFrames;
            fps = Math.trunc(delta / (ms / 1000));
            kHzElement.innerText = fps + ' fps';
        }
    }

    startTime = now;
    lastCycles = cycles;
    lastRenderedFrames = stats.renderedFrames;
    lastFrames = stats.frames;
}

export function toggleShowFPS() {
    showStats = ++showStats % 3;
}

export function updateSound() {
    const soundCheckbox = document.querySelector<HTMLInputElement>('#enable_sound')!;
    const on = soundCheckbox.checked;
    const label = document.querySelector<HTMLDivElement>('#toggle-sound i')!;
    audio.enable(on);
    if (on) {
        label.classList.remove('fa-volume-off');
        label.classList.add('fa-volume-up');
    } else {
        label.classList.remove('fa-volume-up');
        label.classList.add('fa-volume-off');
    }
}

function dumpDisk(drive: DriveNumber) {
    const wind = window.open('', '_blank')!;
    wind.document.title = driveLights.label(drive);
    wind.document.write('<pre>');
    wind.document.write(_disk2.getJSON(drive, true));
    wind.document.write('</pre>');
    wind.document.close();
}

export function reset() {
    _apple2.reset();
}

function loadBinary(bin: JSONBinaryImage) {
    for (let idx = 0; idx < bin.length; idx++) {
        const pos = bin.start + idx;
        cpu.write(pos, bin.data[idx]);
    }
    cpu.reset();
    cpu.setPC(bin.start);
}

export function selectCategory() {
    const diskSelect = document.querySelector<HTMLSelectElement>('#disk_select')!;
    const categorySelect = document.querySelector<HTMLSelectElement>('#category_select')!;
    diskSelect.innerHTML = '';
    const cat = disk_categories[categorySelect.value];
    if (cat) {
        for (let idx = 0; idx < cat.length; idx++) {
            const file = cat[idx];
            let name = file.name;
            if (file.disk) {
                name += ' - ' + file.disk;
            }
            const option = document.createElement('option');
            option.value = file.filename;
            option.innerText = name;
            diskSelect.append(option);
            if (disk_cur_name[_currentDrive] === name) {
                option.selected = true;
            }
        }
    }
}

export function selectDisk() {
    const localFile = document.querySelector<HTMLInputElement>('#local_file')!;
    localFile.value = '';
}

export function clickDisk() {
    doLoad();
}

/** Called to load disks from the local catalog. */
function loadDisk(drive: DriveNumber, disk: JSONDisk) {
    let name = disk.name;
    const category = disk.category!; // all disks in the local catalog have a category

    if (disk.disk) {
        name += ' - ' + disk.disk;
    }

    disk_cur_cat[drive] = category;
    disk_cur_name[drive] = name;

    _disk2.setDisk(drive, disk);
    initGamepad(disk.gamepad);
}

/*
 *  LocalStorage Disk Storage
 */

function updateLocalStorage() {
    const diskIndex = JSON.parse(window.localStorage.diskIndex || '{}');
    const names = Object.keys(diskIndex);

    const cat: DiskDescriptor[] = disk_categories['Local Saves'] = [];
    const contentDiv = document.querySelector<HTMLDivElement>('#manage-modal-content')!;
    contentDiv.innerHTML = '';

    names.forEach(function (name) {
        cat.push({
            'category': 'Local Saves',
            'name': name,
            'filename': 'local:' + name
        });
        contentDiv.innerHTML =
            '<span class="local_save">' +
            name +
            ' <a href="#" onclick="Apple2.doDelete(\'' +
            name +
            '\')">Delete</a><br /></span>';
    });
    cat.push({
        'category': 'Local Saves',
        'name': 'Manage Saves...',
        'filename': 'local:__manage'
    });
}

type LocalDiskIndex = {
    [name: string]: string,
}

function saveLocalStorage(drive: DriveNumber, name: string) {
    const diskIndex = JSON.parse(window.localStorage.diskIndex || '{}') as LocalDiskIndex;

    const json = _disk2.getJSON(drive);
    diskIndex[name] = json;

    window.localStorage.diskIndex = JSON.stringify(diskIndex);

    driveLights.label(drive, name);
    driveLights.dirty(drive, false);
    updateLocalStorage();
}

function deleteLocalStorage(name: string) {
    const diskIndex = JSON.parse(window.localStorage.diskIndex || '{}') as LocalDiskIndex;
    if (diskIndex[name]) {
        delete diskIndex[name];
        openAlert('Deleted');
    }
    window.localStorage.diskIndex = JSON.stringify(diskIndex);
    updateLocalStorage();
}

function loadLocalStorage(drive: DriveNumber, name: string) {
    const diskIndex = JSON.parse(window.localStorage.diskIndex || '{}') as LocalDiskIndex;
    if (diskIndex[name]) {
        _disk2.setJSON(drive, diskIndex[name]);
        driveLights.label(drive, name);
        driveLights.dirty(drive, false);
    }
}

if (window.localStorage !== undefined) {
    const nodes = document.querySelectorAll<HTMLElement>('.disksave');
    nodes.forEach(function (el) {
        el.style.display = 'inline-block';
    });
}

const categorySelect = document.querySelector<HTMLSelectElement>('#category_select')!;

declare global {
    interface Window {
        disk_index: DiskDescriptor[];
        e: boolean;
    }
}

let oldcat = '';
let option;
for (let idx = 0; idx < window.disk_index.length; idx++) {
    const file = window.disk_index[idx];
    const cat = file.category;
    const name = file.name;
    const disk = file.disk;
    if (file.e && !window.e) {
        continue;
    }
    if (cat != oldcat) {
        option = document.createElement('option');
        option.value = cat;
        option.innerText = cat;
        categorySelect.append(option);

        disk_categories[cat] = [];
        oldcat = cat;
    }
    disk_categories[cat].push(file);
    if (disk) {
        if (!disk_sets[name]) {
            disk_sets[name] = [];
        }
        disk_sets[name].push(file);
    }
}
option = document.createElement('option');
option.innerText = 'Local Saves';
categorySelect.append(option);

updateLocalStorage();

/**
 * Processes the URL fragment. It is expected to be of the form:
 * `disk1|disk2` where each disk is the name of a local image OR
 * a URL.
 */
function processHash(hash: string) {
    const files = hash.split('|');
    for (let idx = 0; idx < Math.min(2, files.length); idx++) {
        const drive = idx + 1;
        if (!includes(DRIVE_NUMBERS, drive)) {
            break;
        }
        const file = files[idx];
        if (file.indexOf('://') > 0) {
            const parts = file.split('.');
            const ext = parts[parts.length - 1].toLowerCase();
            if (ext == 'json') {
                loadAjax(drive, file);
            } else {
                doLoadHTTP(drive, file);
            }
        } else if (file) {
            loadAjax(drive, 'json/disks/' + file + '.json');
        }
    }
}


/*
 * Keyboard/Gamepad routines
 */
declare global {
    interface Document {
        webkitCancelFullScreen: () => void;
        webkitIsFullScreen: boolean;
        mozCancelFullScreen: () => void;
        mozIsFullScreen: boolean;
    }
    interface Element {
        webkitRequestFullScreen: (options?: any) => void;
        mozRequestFullScreen: () => void;
    }
}


function _keydown(evt: KeyboardEvent) {
    if (!focused && (!evt.metaKey || evt.ctrlKey || window.e)) {
        evt.preventDefault();

        const key = keyboard.mapKeyEvent(evt);
        if (key !== 0xff) {
            io.keyDown(key);
        }
    }
    if (evt.keyCode === 112) { // F1 - Reset
        cpu.reset();
        evt.preventDefault(); // prevent launching help
    } else if (evt.keyCode === 113) { // F2 - Full Screen
        const elem = document.getElementById('screen')!;
        if (evt.shiftKey) { // Full window, but not full screen
            document.body.classList.toggle('full-page');
        } else if (document.webkitCancelFullScreen) {
            if (document.webkitIsFullScreen) {
                document.webkitCancelFullScreen();
            } else {
                const allowKeyboardInput = (Element as any).ALLOW_KEYBOARD_INPUT;
                if (allowKeyboardInput) {
                    elem.webkitRequestFullScreen(allowKeyboardInput);
                } else {
                    elem.webkitRequestFullScreen();
                }
            }
        } else if (document.mozCancelFullScreen) {
            if (document.mozIsFullScreen) {
                document.mozCancelFullScreen();
            } else {
                elem.mozRequestFullScreen();
            }
        }
    } else if (evt.keyCode === 114) { // F3
        io.keyDown(0x1b);
    } else if (evt.keyCode === 117) { // F6 Quick Save
        window.localStorage.state = base64_json_stringify(_apple2.getState());
    } else if (evt.keyCode === 120) { // F9 Quick Restore
        if (window.localStorage.state) {
            _apple2.setState(base64_json_parse(window.localStorage.state));
        }
    } else if (evt.keyCode == 16) { // Shift
        keyboard.shiftKey(true);
    } else if (evt.keyCode == 20) { // Caps lock
        keyboard.capslockKey();
    } else if (evt.keyCode == 17) { // Control
        keyboard.controlKey(true);
    } else if (evt.keyCode == 91 || evt.keyCode == 93) { // Command
        keyboard.commandKey(true);
    } else if (evt.keyCode == 18) { // Alt
        if (evt.location == 1) {
            keyboard.commandKey(true);
        } else {
            keyboard.optionKey(true);
        }
    }
}

function _keyup(evt: KeyboardEvent) {
    if (!focused)
        io.keyUp();

    if (evt.keyCode == 16) { // Shift
        keyboard.shiftKey(false);
    } else if (evt.keyCode == 17) { // Control
        keyboard.controlKey(false);
    } else if (evt.keyCode == 91 || evt.keyCode == 93) { // Command
        keyboard.commandKey(false);
    } else if (evt.keyCode == 18) { // Alt
        if (evt.location == 1) {
            keyboard.commandKey(false);
        } else {
            keyboard.optionKey(false);
        }
    }
}

export function updateScreen() {
    const mono = document.querySelector<HTMLInputElement>('#mono_screen')!.checked;
    const scanlines = document.querySelector<HTMLInputElement>('#show_scanlines')!.checked;
    const gl = document.querySelector<HTMLInputElement>('#gl_canvas')!.checked;

    const screen = document.querySelector<HTMLDivElement>('#screen')!;
    const overscan = document.querySelector<HTMLDivElement>('.overscan')!;
    if (scanlines && !gl) {
        overscan.classList.add('scanlines');
    } else {
        overscan.classList.remove('scanlines');
    }
    if (mono && !gl) {
        screen.classList.add('mono');
    } else {
        screen.classList.remove('mono');
    }
    vm.mono(mono);
}

export function updateCPU() {
    const accelerated = document.querySelector<HTMLInputElement>('#accelerator_toggle')!.checked;
    const kHz = accelerated ? 4092 : 1023;
    io.updateKHz(kHz);
}

export function updateUI() {
    if (document.location.hash != hashtag) {
        hashtag = document.location.hash;
        const hash = hup();
        if (hash) {
            processHash(hash);
        }
    }
}

let disableMouseJoystick = false;
let flipX = false;
let flipY = false;
let swapXY = false;

export function updateJoystick() {
    disableMouseJoystick = document.querySelector<HTMLInputElement>('#disable_mouse')!.checked;
    flipX = document.querySelector<HTMLInputElement>('#flip_x')!.checked;
    flipY = document.querySelector<HTMLInputElement>('#flip_y')!.checked;
    swapXY = document.querySelector<HTMLInputElement>('#swap_x_y')!.checked;
    configGamepad(flipX, flipY);

    if (disableMouseJoystick) {
        io.paddle(0, 0.5);
        io.paddle(1, 0.5);
        return;
    }
}

function _mousemove(evt: MouseEvent) {
    if (gamepad || disableMouseJoystick) {
        return;
    }

    const s = document.querySelector<HTMLDivElement>('#screen')!;
    const offset = s.getBoundingClientRect();
    let x = (evt.pageX - offset.left) / s.clientWidth;
    let y = (evt.pageY - offset.top) / s.clientHeight;
    const z = x;

    if (swapXY) {
        x = y;
        y = z;
    }

    io.paddle(0, flipX ? 1 - x : x);
    io.paddle(1, flipY ? 1 - y : y);
}

export function pauseRun() {
    const label = document.querySelector<HTMLElement>('#pause-run i')!;
    if (paused) {
        vm.ready.then(() => {
            _apple2.run();
        });
        label.classList.remove('fa-play');
        label.classList.add('fa-pause');
    } else {
        _apple2.stop();
        label.classList.remove('fa-pause');
        label.classList.add('fa-play');
    }
    paused = !paused;
}

export function toggleSound() {
    const enableSound = document.querySelector<HTMLInputElement>('#enable_sound')!;
    enableSound.checked = !enableSound.checked;
    updateSound();
}

export function openOptions() {
    MicroModal.show('options-modal');
}

export function openPrinterModal() {
    const mimeType = 'application/octet-stream';
    const data = _printer.getRawOutput();
    const a = document.querySelector<HTMLAnchorElement>('#raw_printer_output')!;

    const blob = new Blob([data], { 'type': mimeType });
    a.href = window.URL.createObjectURL(blob);
    a.download = 'raw_printer_output.bin';
    MicroModal.show('printer-modal');
}

export function clearPrinterPaper() {
    _printer.clear();
}

declare global {
    interface Window {
        clipboardData?: DataTransfer;
    }
    interface Event {
        clipboardData?: DataTransfer;
    }
    interface Navigator {
        standalone?: boolean;
    }
}

function onLoaded(apple2: Apple2, disk2: DiskII, smartPort: SmartPort, printer: Printer, e: boolean) {
    _apple2 = apple2;
    cpu = _apple2.getCPU();
    io = _apple2.getIO();
    stats = apple2.getStats();
    vm = apple2.getVideoModes();
    tape = new Tape(io);
    _disk2 = disk2;
    _smartPort = smartPort;
    _printer = printer;

    keyboard = new KeyBoard(cpu, io, e);
    keyboard.create('#keyboard');
    audio = new Audio(io);

    MicroModal.init();

    /*
     * Input Handling
     */

    window.addEventListener('keydown', _keydown);
    window.addEventListener('keyup', _keyup);

    window.addEventListener('keydown', audio.autoStart);
    if (window.ontouchstart !== undefined) {
        window.addEventListener('touchstart', audio.autoStart);
    }
    window.addEventListener('mousedown', audio.autoStart);

    window.addEventListener('paste', (event: Event) => {
        const paste = (event.clipboardData || window.clipboardData)!.getData('text');
        io.setKeyBuffer(paste);
        event.preventDefault();
    });

    window.addEventListener('copy', (event) => {
        event.clipboardData!.setData('text/plain', vm.getText());
        event.preventDefault();
    });


    document.querySelectorAll('canvas').forEach(function (canvas) {
        canvas.addEventListener('mousedown', function (evt) {
            if (!gamepad) {
                io.buttonDown(evt.which == 1 ? 0 : 1);
            }
            evt.preventDefault();
        });
        canvas.addEventListener('mouseup', function (evt) {
            if (!gamepad) {
                io.buttonUp(evt.which == 1 ? 0 : 1);
            }
        });
        canvas.addEventListener('contextmenu', function (evt) {
            evt.preventDefault();
        });
    });

    document.body.addEventListener('mousemove', _mousemove);

    document.querySelectorAll('input,textarea').forEach(function (input) {
        input.addEventListener('focus', function () { focused = true; });
        input.addEventListener('blur', function () { focused = false; });
    });

    if (prefs.havePrefs()) {
        document.querySelectorAll<HTMLInputElement>('#options-modal input[type=checkbox]').forEach(function (el) {
            const val = prefs.readPref(el.id);
            if (val) {
                el.checked = JSON.parse(val);
            }
            el.addEventListener('change', function () {
                prefs.writePref(el.id, JSON.stringify(el.checked));
            });
        });
        document.querySelectorAll<HTMLSelectElement>('#options-modal select').forEach(function (el) {
            const val = prefs.readPref(el.id);
            if (val) {
                el.value = val;
            }
            el.addEventListener('change', function () {
                prefs.writePref(el.id, el.value);
            });
        });
    }

    if (navigator.standalone) {
        document.body.classList.add('standalone');
    }

    cpu.reset();
    setInterval(updateKHz, 1000);
    updateSound();
    updateScreen();
    updateCPU();
    initGamepad();

    // Check for disks in hashtag

    const hash = gup('disk') || hup();
    if (hash) {
        _apple2.stop();
        processHash(hash);
    } else {
        vm.ready.then(() => {
            _apple2.run();
        });
    }
}

export function initUI(apple2: Apple2, disk2: DiskII, smartPort: SmartPort, printer: Printer, e: boolean) {
    window.addEventListener('load', () => {
        onLoaded(apple2, disk2, smartPort, printer, e);
    });
}