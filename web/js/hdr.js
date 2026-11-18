// HDR signal-chain checklist: questions plus rules that rank the likely causes
// of "HDR looks barely better than SDR". Pure.

export const HDR_QUESTIONS = [
  {
    id: 'atvFormat',
    group: 'Apple TV',
    q: 'Apple TV › Settings › Video and Audio › Format',
    options: ['4K SDR', '4K HDR', '4K Dolby Vision', '1080p (any)', "Don't know"],
  },
  {
    id: 'matchRange',
    group: 'Apple TV',
    q: 'Apple TV › Video and Audio › Match Content › Match Dynamic Range',
    options: ['On', 'Off', "Don't know"],
  },
  {
    id: 'matchRate',
    group: 'Apple TV',
    q: 'Apple TV › Video and Audio › Match Content › Match Frame Rate',
    options: ['On', 'Off', "Don't know"],
  },
  {
    id: 'hdmiOutput',
    group: 'Apple TV',
    q: 'Apple TV › Video and Audio › HDMI Output',
    options: ['Auto / YCbCr', 'RGB High', 'RGB Low', "Don't know"],
  },
  {
    id: 'atvColorBalance',
    group: 'Apple TV',
    q: 'Have you run the Apple TV "Color Balance" with your iPhone?',
    options: ['Yes', 'No', "Don't know"],
  },
  {
    id: 'projShowsHdr',
    group: 'Projector',
    q: 'While an HDR movie plays (look for the HDR or Dolby Vision badge in the TV app), what does the projector\'s info/status screen say?',
    options: ['HDR10 / BT.2020 / PQ', 'SDR / BT.709 / nothing about HDR', 'No info screen', "Haven't checked"],
  },
  {
    id: 'homeShowsHdr',
    group: 'Projector',
    q: 'On the Apple TV home screen (nothing playing), is the projector in HDR or SDR mode?',
    options: ['SDR', 'HDR', "Don't know"],
  },
  {
    id: 'hdmiEnhanced',
    group: 'Projector',
    q: 'Projector HDMI input setting for 4K HDR (called "Enhanced", "EDID 2.0", "Deep Colour", "HDMI Signal Format", "Expanded")',
    options: ['Enabled', 'Disabled', 'No such setting', "Don't know"],
  },
  {
    id: 'hdmiPort',
    group: 'Projector',
    q: 'Is the Apple TV in the HDMI port that the manual lists as 4K HDR / HDCP 2.2 capable?',
    options: ['Yes', 'No', "Don't know"],
  },
  {
    id: 'cable',
    group: 'Projector',
    q: 'HDMI cable',
    options: ['Certified Premium High Speed (18 Gbps) or Ultra High Speed', 'Long run (over 25 ft / 8 m) or active/optical', 'Old or unknown cable'],
  },
  {
    id: 'lightOutput',
    group: 'Projector',
    q: 'Laser / lamp power in the HDR picture mode',
    options: ['Eco / Low', 'Normal / Medium', 'High / Max', "Don't know"],
  },
  {
    id: 'toneMap',
    group: 'Projector',
    q: 'HDR tone-mapping setting (HDR Brightness, HDR10 Setting, Dynamic Tone Mapping…)',
    options: ['At default', 'Set for maximum highlight detail (darkest)', 'Set brightest', 'Dynamic / automatic', 'No such setting'],
  },
  {
    id: 'dynamicContrast',
    group: 'Projector',
    q: 'Dynamic iris / dynamic contrast / laser dimming',
    options: ['On', 'Off', 'No such feature'],
  },
  {
    id: 'room',
    group: 'Room',
    q: 'Room lighting while watching',
    options: ['Dark (light-controlled)', 'Dim', 'Lights on / daylight'],
  },
  {
    id: 'walls',
    group: 'Room',
    q: 'Walls and ceiling near the screen',
    options: ['Dark / matte', 'White or light-coloured'],
  },
  {
    id: 'service',
    group: 'Content',
    q: 'Where is the HDR content coming from?',
    options: ['Apple TV app / Disney+ / Max (HDR plan)', 'Netflix Premium', 'Netflix Standard or Basic', 'YouTube', 'Mixed / not sure'],
  },
];

/** Estimated peak luminance on screen in nits (cd/m²). */
export function estimateNits({ lumens, diagonalIn, aspect = 16 / 9, gain = 1.0, efficiency = 0.6 }) {
  if (!lumens || !diagonalIn) return null;
  const diagM = diagonalIn * 0.0254;
  const h = diagM / Math.sqrt(1 + aspect * aspect);
  const w = h * aspect;
  const area = w * h;
  // Lambertian screen: L = E * gain / pi; "efficiency" covers calibrated vs
  // brochure lumens (real calibrated output is often 50-70% of the spec).
  return (lumens * efficiency * gain) / (Math.PI * area);
}

/**
 * Returns findings sorted by severity. Each: {sev: 'high'|'medium'|'low'|'info', title, why, fix}
 */
export function diagnoseHdr(ans, { nits = null } = {}) {
  const f = [];
  const add = (sev, title, why, fix) => f.push({ sev, title, why, fix });

  const fmt = ans.atvFormat;
  if ((fmt === '4K HDR' || fmt === '4K Dolby Vision') && ans.matchRange === 'Off') {
    add(
      'high',
      'Everything is sent as HDR, including SDR content',
      'With Format set to HDR and Match Dynamic Range off, the Apple TV converts SDR shows, menus and apps into HDR. The projector stays in its HDR mode all the time, so SDR and HDR end up looking alike. SDR also usually looks dimmer and a little off this way.',
      'Set Format to 4K SDR and turn on Match Content › Match Dynamic Range and Match Frame Rate. The Apple TV then switches to HDR only when the content is HDR.',
    );
  } else if (ans.homeShowsHdr === 'HDR' && ans.matchRange !== 'Off') {
    add(
      'medium',
      'The projector is in HDR mode on the home screen',
      'The menus are being sent as HDR, so the projector rarely switches between its SDR and HDR modes, and you never see the contrast between the two.',
      'Set Format to 4K SDR with Match Dynamic Range on.',
    );
  }
  if (fmt === '1080p (any)') {
    add('high', 'Apple TV output is 1080p', 'HDR10 and Dolby Vision on the Apple TV 4K need a 4K output mode.', 'Set Format to 4K SDR (with Match Dynamic Range on). If 4K is not offered, the projector\'s HDMI port, EDID setting or cable is limiting it.');
  }
  if (ans.projShowsHdr === 'SDR / BT.709 / nothing about HDR') {
    add(
      'high',
      'HDR is not reaching the projector',
      'When an HDR title plays, the projector should report HDR10 / BT.2020. If it doesn\'t, you are watching a converted SDR picture.',
      'Check in this order: Match Dynamic Range on; the projector\'s HDMI "Enhanced/EDID" setting enabled for that port; the Apple TV plugged into the HDR-capable port; a certified 18 Gbps cable. Then confirm with Apple TV › Video and Audio › Format › "Check HDR".',
    );
  } else if (ans.projShowsHdr === "Haven't checked" || ans.projShowsHdr === 'No info screen') {
    add('medium', 'Confirm the projector actually receives HDR', 'Everything else depends on this.', 'Play an HDR title and open the projector\'s Info / Status / Signal menu. Or play the generated hdr_hl1000 video: in HDR mode, brightness stops rising around 1,000 nits; if it keeps rising to 10,000, the projector is not doing HDR tone mapping.');
  }
  if (ans.hdmiEnhanced === 'Disabled') {
    add('high', 'The projector\'s HDMI input is in basic mode', 'Many projectors default to an HDMI 1.4-style mode that does not offer 4K60 HDR to the Apple TV.', 'Enable "Enhanced", "EDID 2.0", "HDMI Deep Colour" or "Signal Format: Enhanced" for the input the Apple TV uses, then re-check the Apple TV Format list.');
  } else if (ans.hdmiEnhanced === "Don't know") {
    add('low', 'Check the projector\'s HDMI input mode', 'Some projectors only accept 4K HDR after an HDMI input setting is enabled.', 'Search the projector manual for "EDID", "Enhanced" or "HDMI signal format".');
  }
  if (ans.hdmiPort === 'No') add('high', 'Wrong HDMI port', 'Only some projector inputs support HDCP 2.2 and 4K HDR.', 'Move the Apple TV to the port the manual marks as 4K / HDR / HDCP 2.2.');
  if (ans.cable === 'Old or unknown cable' || ans.cable?.startsWith('Long')) {
    add('medium', 'The cable may not carry 4K HDR reliably', '4K60 HDR needs about 18 Gbps. Weak cables cause the Apple TV to fall back to lower formats, or cause dropouts.', 'Use a certified Premium High Speed or Ultra High Speed cable; for long runs, an active or optical cable rated for 18 Gbps.');
  }
  if (ans.lightOutput === 'Eco / Low') {
    add('high', 'Light output is on Eco/Low for HDR', 'HDR depends on peak brightness. Eco mode can remove a third or more of the light, and with it most of the HDR punch.', 'Use High/Max power in the HDR picture mode (projectors store this per mode).');
  }
  if (ans.toneMap === 'Set for maximum highlight detail (darkest)') {
    add('medium', 'Tone mapping is at its darkest setting', 'That setting keeps detail in 4,000-nit highlights but makes everyday scenes dim and flat, which reads as "not much better than SDR".', 'Move it 2–3 steps toward brighter, then use the HDR highlight test here to find the balance.');
  }
  if (ans.dynamicContrast === 'Off') {
    add('low', 'Dynamic iris / dimming is off', 'On most projectors, a dynamic iris or laser dimming is what produces deep blacks in dark scenes. That contrast is a big part of what makes HDR look like HDR.', 'Try it On (or "High") for HDR. Some people dislike visible pumping, so judge by eye.');
  }
  if (ans.hdmiOutput === 'RGB High' || ans.hdmiOutput === 'RGB Low') {
    add('medium', 'Apple TV HDMI output is forced to RGB', 'A forced RGB range that does not match the projector\'s expected range either crushes shadows or turns black gray. HDR also normally travels as YCbCr.', 'Set HDMI Output to Auto/YCbCr and the projector\'s HDMI range to Auto.');
  }
  if (ans.atvColorBalance === 'Yes') {
    add('low', 'Apple TV Color Balance is active', 'It adjusts the Apple TV\'s output, not the projector, and was measured before this calibration.', 'Turn it off (Video and Audio › Calibrate › Color Balance) while calibrating; re-run it afterwards if you like the result.');
  }
  if (ans.matchRate === 'Off') add('low', 'Match Frame Rate is off', 'Films play at 60 Hz with uneven motion (judder). This does not affect HDR, but it is an easy fix.', 'Turn on Match Content › Match Frame Rate.');
  if (ans.room === 'Lights on / daylight') add('high', 'Ambient light', 'Room light falling on a projection screen lifts black far more than on a TV. HDR\'s extra contrast disappears first.', 'HDR on a projector needs a dark room; in daylight an SDR mode is usually the better choice.');
  if (ans.walls === 'White or light-coloured') add('medium', 'Light walls reflect the image back', 'Bright scenes bounce off white walls and ceiling onto the screen and wash out dark areas in the same frame, which flattens HDR.', 'Dark, matte surfaces near the screen (even a dark rug and curtains) help a lot.');
  if (ans.service === 'Netflix Standard or Basic') add('high', 'Your Netflix plan does not stream HDR', 'Netflix sends HDR10 / Dolby Vision only on the Premium plan.', 'Compare with an Apple TV+ title (all of them are HDR) before changing any settings.');

  if (nits != null) {
    if (nits < 80) {
      add('info', `Estimated peak brightness ≈ ${Math.round(nits)} nits`, 'HDR is mastered for 1,000+ nit displays. Below about 80 nits on screen, tone mapping has very little room, so HDR\'s advantage is mostly wider colour rather than brighter highlights. Some of what you\'re seeing may be a hardware limit.', 'A smaller or higher-gain screen, or Max light output, raises it. Check that the HDR mode uses a wide-colour (BT.2020/DCI-P3) setting if one exists.');
    } else {
      add('info', `Estimated peak brightness ≈ ${Math.round(nits)} nits`, 'Good for a projector. Typical home-theatre HDR targets are 80–150 nits on screen.', 'Tone-mapping balance matters more than raw brightness at this level.');
    }
  }
  const order = { high: 0, medium: 1, low: 2, info: 3 };
  return f.sort((a, b) => order[a.sev] - order[b.sev]);
}
