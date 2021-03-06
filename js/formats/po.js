/* Copyright 2010-2019 Will Scullin <scullin@scullinsteel.com>
 *
 * Permission to use, copy, modify, distribute, and sell this software and its
 * documentation for any purpose is hereby granted without fee, provided that
 * the above copyright notice appear in all copies and that both that
 * copyright notice and this permission notice appear in supporting
 * documentation.  No representations are made about the suitability of this
 * software for any purpose.  It is provided "as is" without express or
 * implied warranty.
 */

import { explodeSector16, PO } from './format_utils';
import { bytify } from '../util';

/**
 * Returns a `Disk` object from ProDOS-ordered image data.
 * @param {*} options the disk image and options
 * @returns {import('./format_utils').Disk}
 */
export default function ProDOS(options) {
    var { data, name, rawData, volume, readOnly } = options;
    var disk = {
        format: 'nib',
        name,
        volume: volume || 254,
        tracks: [],
        readOnly: readOnly || false,
        trackMap: null,
        rawTracks: null
    };

    for (var physical_track = 0; physical_track < 35; physical_track++) {
        var track = [];
        for (var physical_sector = 0; physical_sector < 16; physical_sector++) {
            const prodos_sector = PO[physical_sector];
            var sector;
            if (rawData) {
                var off = (16 * physical_track + prodos_sector) * 256;
                sector = new Uint8Array(rawData.slice(off, off + 256));
            } else {
                sector = data[physical_track][prodos_sector];
            }
            track = track.concat(
                explodeSector16(volume, physical_track, physical_sector, sector)
            );
        }
        disk.tracks[physical_track] = bytify(track);
    }

    return disk;
}
