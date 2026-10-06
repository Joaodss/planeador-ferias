/* País de cada fuso, para mostrar e procurar nos selects de fuso: o browser não o diz.
   Tirado do zone.tab da base de dados tz da IANA (tzdb 2026e), que dá um país (código ISO 3166) a cada fuso.
   Está por país e pela cidade (a última parte do nome do fuso), porque o Chrome e o Node listam alguns nomes antigos
   (America/Buenos_Aires em vez de America/Argentina/Buenos_Aires) e as cidades não se repetem. */
const BY_COUNTRY = {
  AD:'Andorra', AE:'Dubai', AF:'Kabul', AG:'Antigua', AI:'Anguilla', AL:'Tirane', AM:'Yerevan', AO:'Luanda',
  AQ:'McMurdo Casey Davis DumontDUrville Mawson Palmer Rothera Syowa Troll Vostok',
  AR:'Buenos_Aires Cordoba Salta Jujuy Tucuman Catamarca La_Rioja San_Juan Mendoza San_Luis Rio_Gallegos Ushuaia',
  AS:'Pago_Pago', AT:'Vienna',
  AU:'Lord_Howe Macquarie Hobart Melbourne Sydney Broken_Hill Brisbane Lindeman Adelaide Darwin Perth Eucla',
  AW:'Aruba', AX:'Mariehamn', AZ:'Baku', BA:'Sarajevo', BB:'Barbados', BD:'Dhaka', BE:'Brussels',
  BF:'Ouagadougou', BG:'Sofia', BH:'Bahrain', BI:'Bujumbura', BJ:'Porto-Novo', BL:'St_Barthelemy',
  BM:'Bermuda', BN:'Brunei', BO:'La_Paz', BQ:'Kralendijk',
  BR:'Noronha Belem Fortaleza Recife Araguaina Maceio Bahia Sao_Paulo Campo_Grande Cuiaba Santarem Porto_Velho Boa_Vista Manaus Eirunepe Rio_Branco',
  BS:'Nassau', BT:'Thimphu', BW:'Gaborone', BY:'Minsk', BZ:'Belize',
  CA:'St_Johns Halifax Glace_Bay Moncton Goose_Bay Blanc-Sablon Toronto Iqaluit Atikokan Winnipeg Resolute Rankin_Inlet Regina Swift_Current Edmonton Cambridge_Bay Inuvik Vancouver Creston Dawson_Creek Fort_Nelson Whitehorse Dawson',
  CC:'Cocos', CD:'Kinshasa Lubumbashi', CF:'Bangui', CG:'Brazzaville', CH:'Zurich', CI:'Abidjan',
  CK:'Rarotonga', CL:'Santiago Coyhaique Punta_Arenas Easter', CM:'Douala', CN:'Shanghai Urumqi', CO:'Bogota',
  CR:'Costa_Rica', CU:'Havana', CV:'Cape_Verde', CW:'Curacao', CX:'Christmas', CY:'Nicosia Famagusta',
  CZ:'Prague', DE:'Berlin Busingen', DJ:'Djibouti', DK:'Copenhagen', DM:'Dominica', DO:'Santo_Domingo',
  DZ:'Algiers', EC:'Guayaquil Galapagos', EE:'Tallinn', EG:'Cairo', EH:'El_Aaiun', ER:'Asmara',
  ES:'Madrid Ceuta Canary', ET:'Addis_Ababa', FI:'Helsinki', FJ:'Fiji', FK:'Stanley',
  FM:'Chuuk Pohnpei Kosrae', FO:'Faroe', FR:'Paris', GA:'Libreville', GB:'London', GD:'Grenada', GE:'Tbilisi',
  GF:'Cayenne', GG:'Guernsey', GH:'Accra', GI:'Gibraltar', GL:'Nuuk Danmarkshavn Scoresbysund Thule',
  GM:'Banjul', GN:'Conakry', GP:'Guadeloupe', GQ:'Malabo', GR:'Athens', GS:'South_Georgia', GT:'Guatemala',
  GU:'Guam', GW:'Bissau', GY:'Guyana', HK:'Hong_Kong', HN:'Tegucigalpa', HR:'Zagreb', HT:'Port-au-Prince',
  HU:'Budapest', ID:'Jakarta Pontianak Makassar Jayapura', IE:'Dublin', IL:'Jerusalem', IM:'Isle_of_Man',
  IN:'Kolkata', IO:'Chagos', IQ:'Baghdad', IR:'Tehran', IS:'Reykjavik', IT:'Rome', JE:'Jersey', JM:'Jamaica',
  JO:'Amman', JP:'Tokyo', KE:'Nairobi', KG:'Bishkek', KH:'Phnom_Penh', KI:'Tarawa Kanton Kiritimati',
  KM:'Comoro', KN:'St_Kitts', KP:'Pyongyang', KR:'Seoul', KW:'Kuwait', KY:'Cayman',
  KZ:'Almaty Qyzylorda Qostanay Aqtobe Aqtau Atyrau Oral', LA:'Vientiane', LB:'Beirut', LC:'St_Lucia',
  LI:'Vaduz', LK:'Colombo', LR:'Monrovia', LS:'Maseru', LT:'Vilnius', LU:'Luxembourg', LV:'Riga', LY:'Tripoli',
  MA:'Casablanca', MC:'Monaco', MD:'Chisinau', ME:'Podgorica', MF:'Marigot', MG:'Antananarivo',
  MH:'Majuro Kwajalein', MK:'Skopje', ML:'Bamako', MM:'Yangon', MN:'Ulaanbaatar Hovd', MO:'Macau', MP:'Saipan',
  MQ:'Martinique', MR:'Nouakchott', MS:'Montserrat', MT:'Malta', MU:'Mauritius', MV:'Maldives', MW:'Blantyre',
  MX:'Mexico_City Cancun Merida Monterrey Matamoros Chihuahua Ciudad_Juarez Ojinaga Mazatlan Bahia_Banderas Hermosillo Tijuana',
  MY:'Kuala_Lumpur Kuching', MZ:'Maputo', NA:'Windhoek', NC:'Noumea', NE:'Niamey', NF:'Norfolk', NG:'Lagos',
  NI:'Managua', NL:'Amsterdam', NO:'Oslo', NP:'Kathmandu', NR:'Nauru', NU:'Niue', NZ:'Auckland Chatham',
  OM:'Muscat', PA:'Panama', PE:'Lima', PF:'Tahiti Marquesas Gambier', PG:'Port_Moresby Bougainville',
  PH:'Manila', PK:'Karachi', PL:'Warsaw', PM:'Miquelon', PN:'Pitcairn', PR:'Puerto_Rico', PS:'Gaza Hebron',
  PT:'Lisbon Madeira Azores', PW:'Palau', PY:'Asuncion', QA:'Qatar', RE:'Reunion', RO:'Bucharest',
  RS:'Belgrade',
  RU:'Kaliningrad Moscow Kirov Volgograd Astrakhan Saratov Ulyanovsk Samara Yekaterinburg Omsk Novosibirsk Barnaul Tomsk Novokuznetsk Krasnoyarsk Irkutsk Chita Yakutsk Khandyga Vladivostok Ust-Nera Magadan Sakhalin Srednekolymsk Kamchatka Anadyr',
  RW:'Kigali', SA:'Riyadh', SB:'Guadalcanal', SC:'Mahe', SD:'Khartoum', SE:'Stockholm', SG:'Singapore',
  SH:'St_Helena', SI:'Ljubljana', SJ:'Longyearbyen', SK:'Bratislava', SL:'Freetown', SM:'San_Marino',
  SN:'Dakar', SO:'Mogadishu', SR:'Paramaribo', SS:'Juba', ST:'Sao_Tome', SV:'El_Salvador', SX:'Lower_Princes',
  SY:'Damascus', SZ:'Mbabane', TC:'Grand_Turk', TD:'Ndjamena', TF:'Kerguelen', TG:'Lome', TH:'Bangkok',
  TJ:'Dushanbe', TK:'Fakaofo', TL:'Dili', TM:'Ashgabat', TN:'Tunis', TO:'Tongatapu', TR:'Istanbul',
  TT:'Port_of_Spain', TV:'Funafuti', TW:'Taipei', TZ:'Dar_es_Salaam', UA:'Simferopol Kyiv', UG:'Kampala',
  UM:'Midway Wake',
  US:'New_York Detroit Louisville Monticello Indianapolis Vincennes Winamac Marengo Petersburg Vevay Chicago Tell_City Knox Menominee Center New_Salem Beulah Denver Boise Phoenix Los_Angeles Anchorage Juneau Sitka Metlakatla Yakutat Nome Adak Honolulu',
  UY:'Montevideo', UZ:'Samarkand Tashkent', VA:'Vatican', VC:'St_Vincent', VE:'Caracas', VG:'Tortola',
  VI:'St_Thomas', VN:'Ho_Chi_Minh', VU:'Efate', WF:'Wallis', WS:'Apia', YE:'Aden', YT:'Mayotte',
  ZA:'Johannesburg', ZM:'Lusaka', ZW:'Harare'
};

let byCity = null;
/** "Europe/Lisbon" → "PT"; '' para um fuso sem país (UTC, Etc/…).
   @param {string} tz
   @returns {string} código ISO 3166 */
export function tzCountry(tz){
  if(!byCity){
    byCity = new Map();
    for(const [cc, cities] of Object.entries(BY_COUNTRY)) for(const c of cities.split(' ')) byCity.set(c, cc);
  }
  return byCity.get(String(tz||'').split('/').pop()) || '';
}
