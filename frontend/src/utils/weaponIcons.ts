export const GRENADE_ICON_PATH: Record<string, string> = {
  weapon_hegrenade:    '/icons/he-grenade-icon.svg',
  weapon_flashbang:    '/icons/flashbang-icon.svg',
  weapon_smokegrenade: '/icons/smoke-grenade-icon.svg',
  weapon_molotov:      '/icons/molotov-icon.svg',
  weapon_incgrenade:   '/icons/incendiary-grenade-icon.svg',
  weapon_decoy:        '/icons/decoy-icon.svg',
};

export const WEAPON_ICON_PATH: Record<string, string> = {
  // Pistols
  weapon_glock:         '/icons/glock-icon.svg',
  weapon_hkp2000:       '/icons/p2000-icon.svg',
  weapon_usp_silencer:  '/icons/usps-icon.svg',
  weapon_p250:          '/icons/p250-icon.svg',
  weapon_fiveseven:     '/icons/five-seven-icon.svg',
  weapon_cz75a:         '/icons/cz75a-icon.svg',
  weapon_deagle:        '/icons/deagle-icon.svg',
  weapon_revolver:      '/icons/revolver-icon.svg',
  weapon_tec9:          '/icons/tec9-icon.svg',
  weapon_elite:         '/icons/dual-elite-icon.svg',
  // Rifles
  weapon_ak47:          '/icons/ak47-icon.svg',
  weapon_m4a1:          '/icons/m4a4-icon.svg',
  weapon_m4a1_silencer: '/icons/m4a1-icon.svg',
  weapon_famas:         '/icons/famas-icon.svg',
  weapon_galilar:       '/icons/galilar-icon.svg',
  weapon_aug:           '/icons/aug-icon.svg',
  weapon_sg556:         '/icons/sg553-icon.svg',
  // Snipers
  weapon_awp:           '/icons/awp-icon.svg',
  weapon_ssg08:         '/icons/ssg08-icon.svg',
  weapon_scar20:        '/icons/scar20-icon.svg',
  weapon_g3sg1:         '/icons/g3sg1-icon.svg',
  // Shotguns
  weapon_xm1014:        '/icons/xm1014-icon.svg',
  weapon_nova:          '/icons/nova-icon.svg',
  weapon_mag7:          '/icons/mag7-icon.svg',
  weapon_sawedoff:      '/icons/sawed-off-icon.svg',
  // SMGs
  weapon_mp9:           '/icons/mp9-icon.svg',
  weapon_mac10:         '/icons/mac10-icon.svg',
  weapon_ump45:         '/icons/ump45-icon.svg',
  weapon_mp7:           '/icons/mp7-icon.svg',
  weapon_mp5sd:         '/icons/mp5sd-icon.svg',
  weapon_p90:           '/icons/p90-icon.svg',
  weapon_bizon:         '/icons/bizon-icon.svg',
  // Machine guns
  weapon_m249:          '/icons/m249-icon.svg',
  weapon_negev:         '/icons/negev-icon.svg',
  // Knife (covers all knife/bayonet variants)
  weapon_knife:         '/icons/knife-icon.svg',
  weapon_knife_t:       '/icons/knife-icon.svg',
};

export function normalizeWeaponKey(raw: string | null | undefined): string {
  if (!raw) return '';
  const s = raw.toLowerCase().trim();
  if (!s) return '';
  if (s.startsWith('weapon_') || s.startsWith('item_')) return s;
  return `weapon_${s}`;
}

/** Returns the icon src path for any weapon string, or null if unknown. */
export function weaponIconSrc(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const key = normalizeWeaponKey(raw);
  if (WEAPON_ICON_PATH[key]) return WEAPON_ICON_PATH[key];
  if (key.includes('knife') || key.includes('bayonet')) return '/icons/knife-icon.svg';
  return null;
}
