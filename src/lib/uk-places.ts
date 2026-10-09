// UK towns & cities for address dropdowns (checkout + account book).
// Curated list: all official cities + major towns, alphabetical.
export const UK_PLACES = [
  'Aberdeen', 'Aldershot', 'Ashford', 'Aylesbury', 'Bangor', 'Barnsley',
  'Barrow-in-Furness', 'Basildon', 'Basingstoke', 'Bath', 'Bedford', 'Belfast',
  'Birkenhead', 'Birmingham', 'Blackburn', 'Blackpool', 'Bolton', 'Bournemouth',
  'Bradford', 'Brentwood', 'Bridgend', 'Brighton', 'Bristol', 'Burnley',
  'Burton upon Trent', 'Bury', 'Bury St Edmunds', 'Cambridge', 'Canterbury',
  'Cardiff', 'Carlisle', 'Chatham', 'Chelmsford', 'Cheltenham', 'Chester',
  'Chesterfield', 'Chichester', 'Colchester', 'Coventry', 'Crawley', 'Crewe',
  'Croydon', 'Darlington', 'Derby', 'Dewsbury', 'Doncaster', 'Dundee', 'Durham',
  'Eastbourne', 'Eastleigh', 'Edinburgh', 'Ellesmere Port', 'Exeter', 'Gateshead',
  'Gillingham', 'Glasgow', 'Gloucester', 'Grimsby', 'Guildford', 'Halifax',
  'Harrogate', 'Hartlepool', 'Hastings', 'Hemel Hempstead', 'Hereford',
  'High Wycombe', 'Huddersfield', 'Hull', 'Inverness', 'Ipswich', 'Keighley',
  'Kettering', "King's Lynn", 'Kirkcaldy', 'Lancaster', 'Leeds', 'Leicester',
  'Lichfield', 'Lincoln', 'Lisburn', 'Liverpool', 'London', 'Londonderry',
  'Luton', 'Macclesfield', 'Maidstone', 'Manchester', 'Mansfield', 'Margate',
  'Middlesbrough', 'Milton Keynes', 'Newcastle upon Tyne', 'Newport', 'Newry',
  'Northampton', 'Norwich', 'Nottingham', 'Nuneaton', 'Oldham', 'Oxford',
  'Paisley', 'Perth', 'Peterborough', 'Plymouth', 'Poole', 'Portsmouth',
  'Preston', 'Reading', 'Redditch', 'Ripon', 'Rochdale', 'Rotherham', 'Runcorn',
  'Salford', 'Salisbury', 'Scarborough', 'Scunthorpe', 'Sheffield', 'Shrewsbury',
  'Slough', 'Solihull', 'South Shields', 'Southampton', 'Southend-on-Sea',
  'Southport', 'St Albans', 'St Helens', 'Stafford', 'Stevenage', 'Stockport',
  'Stockton-on-Tees', 'Stoke-on-Trent', 'Sunderland', 'Sutton Coldfield',
  'Swansea', 'Swindon', 'Tamworth', 'Taunton', 'Telford', 'Torquay', 'Truro',
  'Wakefield', 'Walsall', 'Warrington', 'Watford', 'Weston-super-Mare', 'Wigan',
  'Winchester', 'Wolverhampton', 'Worcester', 'Worthing', 'Wrexham', 'York',
];
export const OTHER_CITY = '__other';
export function isListedCity(v: string): boolean {
  return UK_PLACES.some((p) => p.toLowerCase() === v.trim().toLowerCase());
}
// Simplified official UK postcode pattern (accepts "E2 8DP", "M1 1AA"...).
const POSTCODE_RE = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i;
export function isUkPostcode(v: string): boolean {
  return POSTCODE_RE.test(v.trim());
}
