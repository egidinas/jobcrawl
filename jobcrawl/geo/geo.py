"""Location hierarchy for job postings: city -> area -> state/region -> country -> continent, from the free text an employer typed.

    resolve("Garching b. München (DE)")  ->  {'places': [{'city': 'Garching', 'area': 'Munich area', 'state': 'Bavaria', 'country': 'DE', 'continent': 'EU'}], ...}

Offline gazetteer (no geocoding service): countries (EN/DE names, ISO codes), German and US states, Canadian/Australian/UK regions, and the cities
that the crawled postings actually name, plus the Munich metropolitan municipalities. A posting may name several places ("Munich / Berlin",
"Rockville, MD or Hawthorne, CA"); each becomes a place, the first is the primary. Postings without a location can be given the employer's
headquarters (flagged inferred). Everything not resolved to a country is reported by `python -m jobcrawl.geo.geo <catalog.json>`.
"""
import copy
import functools
import html
import re
import unicodedata
import sys

CONTINENTS = {'EU': ('Europe', 'Europa'), 'AS': ('Asia', 'Asien'), 'NA': ('North America', 'Nordamerika'), 'SA': ('South America', 'Südamerika'),
              'AF': ('Africa', 'Afrika'), 'OC': ('Oceania', 'Ozeanien')}

# code | English | German | continent | aliases (; separated)
_COUNTRIES = """
DE|Germany|Deutschland|EU|deutschlandweit;bundesweit;deutschland;germany;garmany;deu;federal republic of germany;bundesrepublik deutschland;allemagne
AT|Austria|Österreich|EU|austria;österreich;osterreich;aut
CH|Switzerland|Schweiz|EU|switzerland;schweiz;suisse;svizzera;che
LI|Liechtenstein|Liechtenstein|EU|liechtenstein
FR|France|Frankreich|EU|france;fra;francia
IT|Italy|Italien|EU|italy;italia;italien;ita
ES|Spain|Spanien|EU|spain;españa;espana;esp
PT|Portugal|Portugal|EU|portugal;prt
GB|United Kingdom|Vereinigtes Königreich|EU|united kingdom;uk;gb;gbr;great britain;britain;england and wales;u.k.
IE|Ireland|Irland|EU|ireland;irl;eire
NL|Netherlands|Niederlande|EU|netherlands;the netherlands;nl;nld;holland;niederlande
BE|Belgium|Belgien|EU|belgium;belgië;belgique;belgien;bel
LU|Luxembourg|Luxemburg|EU|luxembourg;luxemburg;lux
DK|Denmark|Dänemark|EU|denmark;danmark;dänemark;dnk
SE|Sweden|Schweden|EU|sweden;sverige;swe;schweden
NO|Norway|Norwegen|EU|norway;norge;nor;norwegen
FI|Finland|Finnland|EU|finland;suomi;fin;finnland
IS|Iceland|Island|EU|iceland
PL|Poland|Polen|EU|poland;polska;pol;polen
CZ|Czechia|Tschechien|EU|czechia;czech republic;česko;tschechien
SK|Slovakia|Slowakei|EU|slovakia;slowakei
HU|Hungary|Ungarn|EU|hungary;magyarország;ungarn
RO|Romania|Rumänien|EU|romania;rumänien
BG|Bulgaria|Bulgarien|EU|bulgaria;bulgarien
GR|Greece|Griechenland|EU|greece;hellas;griechenland;grc
SI|Slovenia|Slowenien|EU|slovenia;slovenija;slowenien
HR|Croatia|Kroatien|EU|croatia;hrvatska;kroatien
RS|Serbia|Serbien|EU|serbia;serbien
EE|Estonia|Estland|EU|estonia;estland
LV|Latvia|Lettland|EU|latvia;lettland
LT|Lithuania|Litauen|EU|lithuania;litauen
MT|Malta|Malta|EU|malta
CY|Cyprus|Zypern|EU|cyprus;zypern
UA|Ukraine|Ukraine|EU|ukraine
TR|Türkiye|Türkei|EU|turkey;türkiye;turkiye;türkei
US|United States|USA|NA|united states;united states of america;usa;u.s.a.;u.s.;us;america;vereinigte staaten
CA|Canada|Kanada|NA|canada;kanada;can
MX|Mexico|Mexiko|NA|mexico;méxico;mexiko
BR|Brazil|Brasilien|SA|brazil;brasil;brasilien
AR|Argentina|Argentinien|SA|argentina;argentinien
CL|Chile|Chile|SA|chile
CO|Colombia|Kolumbien|SA|colombia;kolumbien
PE|Peru|Peru|SA|peru
AE|United Arab Emirates|Vereinigte Arabische Emirate|AS|united arab emirates;uae;u.a.e.;emirates;vereinigte arabische emirate;are
SA|Saudi Arabia|Saudi-Arabien|AS|saudi arabia;ksa;saudi-arabien
QA|Qatar|Katar|AS|qatar;katar
IL|Israel|Israel|AS|israel
JO|Jordan|Jordanien|AS|jordan
IN|India|Indien|AS|india;indien;ind
SG|Singapore|Singapur|AS|singapore;singapur;sg;sgp
JP|Japan|Japan|AS|japan;jpn;日本
CN|China|China|AS|china;cn;chn;prc;people's republic of china
HK|Hong Kong|Hongkong|AS|hong kong;hongkong
TW|Taiwan|Taiwan|AS|taiwan;twn
KR|South Korea|Südkorea|AS|south korea;korea;republic of korea;südkorea
TH|Thailand|Thailand|AS|thailand
MY|Malaysia|Malaysia|AS|malaysia
ID|Indonesia|Indonesien|AS|indonesia;indonesien
VN|Vietnam|Vietnam|AS|vietnam
PH|Philippines|Philippinen|AS|philippines
AU|Australia|Australien|OC|australia;australien;aus
NZ|New Zealand|Neuseeland|OC|new zealand;neuseeland;nz;nzl;aotearoa
ZA|South Africa|Südafrika|AF|south africa;südafrika
EG|Egypt|Ägypten|AF|egypt;ägypten
MA|Morocco|Marokko|AF|morocco;marokko
KE|Kenya|Kenia|AF|kenya;kenia
NG|Nigeria|Nigeria|AF|nigeria
"""

# state/region | EN | DE | country | aliases | (code aliases)
_STATES = """
DE|Bavaria|Bayern|bayern;bavaria;by;freistaat bayern|by
DE|Baden-Württemberg|Baden-Württemberg|baden-württemberg;baden-wuerttemberg;baden württemberg;bw|bw
DE|Berlin|Berlin|berlin|be
DE|Brandenburg|Brandenburg|brandenburg|bb
DE|Bremen|Bremen|bremen|hb
DE|Hamburg|Hamburg|hamburg|hh
DE|Hesse|Hessen|hessen;hesse;he|he
DE|Lower Saxony|Niedersachsen|niedersachsen;lower saxony|ni
DE|Mecklenburg-Western Pomerania|Mecklenburg-Vorpommern|mecklenburg-vorpommern;mecklenburg western pomerania;mecklenburg-western pomerania|mv
DE|North Rhine-Westphalia|Nordrhein-Westfalen|nordrhein-westfalen;nordrhein westfalen;north rhine-westphalia;nrw|nw
DE|Rhineland-Palatinate|Rheinland-Pfalz|rheinland-pfalz;rhineland-palatinate;rheinland pfalz|rp
DE|Saarland|Saarland|saarland|sl
DE|Saxony|Sachsen|sachsen;saxony|sn
DE|Saxony-Anhalt|Sachsen-Anhalt|sachsen-anhalt;saxony-anhalt|st
DE|Schleswig-Holstein|Schleswig-Holstein|schleswig-holstein|sh
DE|Thuringia|Thüringen|thüringen;thuringia;thueringen|th
GB|England|England|england
GB|Scotland|Schottland|scotland;schottland
GB|Wales|Wales|wales
GB|Northern Ireland|Nordirland|northern ireland
CA|Ontario|Ontario|ontario;on
CA|Quebec|Québec|quebec;québec;qc
CA|Nova Scotia|Nova Scotia|nova scotia;ns
CA|British Columbia|British Columbia|british columbia;bc
CA|Alberta|Alberta|alberta;ab
AU|New South Wales|New South Wales|new south wales;nsw
AU|Victoria|Victoria|victoria;vic
AU|Queensland|Queensland|queensland;qld;north qld
AU|Western Australia|Western Australia|western australia;wa
AU|South Australia|South Australia|south australia
AU|Tasmania|Tasmania|tasmania;tas
AU|Australian Capital Territory|Australian Capital Territory|australian capital territory;act
AU|Northern Territory|Northern Territory|northern territory
FR|Île-de-France|Île-de-France|île-de-france;ile-de-france;ile de france
FR|Occitanie|Occitanie|occitanie
FR|Normandy|Normandie|normandie;normandy
FR|Nouvelle-Aquitaine|Nouvelle-Aquitaine|nouvelle-aquitaine
FR|Provence-Alpes-Côte d'Azur|Provence-Alpes-Côte d'Azur|provence-alpes-côte d'azur;paca
FR|Auvergne-Rhône-Alpes|Auvergne-Rhône-Alpes|auvergne-rhône-alpes
FR|Brittany|Bretagne|bretagne;brittany
FR|Hauts-de-France|Hauts-de-France|hauts-de-france
FR|Grand Est|Grand Est|grand est
NL|North Holland|Noord-Holland|north holland;noord-holland
NL|South Holland|Zuid-Holland|south holland;zuid-holland
NL|Overijssel|Overijssel|overijssel
NL|Limburg|Limburg|limburg
NL|North Brabant|Noord-Brabant|north brabant;noord-brabant
NL|Utrecht|Utrecht|utrecht
ES|Community of Madrid|Comunidad de Madrid|community of madrid;comunidad de madrid
ES|Andalusia|Andalusien|andalusia;andalucía
ES|Catalonia|Katalonien|catalonia;cataluña;catalunya
ES|Valencian Community|Valencia|valencian community;comunidad valenciana
CH|Zurich|Zürich|zurich canton
CH|Vaud|Waadt|vaud
CH|Geneva|Genf|geneva canton
CH|Lucerne|Luzern|lucerne canton
CH|Nidwalden|Nidwalden|nidwalden
SE|Norrbotten|Norrbotten|norrbotten
NO|Nordland|Nordland|nordland
GR|Central Macedonia|Zentralmakedonien|central macedonia
IT|Lombardy|Lombardei|lombardy;lombardia
BE|Antwerp|Antwerpen|antwerp province
"""

_US_STATES = """AL Alabama;AK Alaska;AZ Arizona;AR Arkansas;CA California;CO Colorado;CT Connecticut;DE Delaware;FL Florida;GA Georgia;HI Hawaii;ID Idaho;IL Illinois;IN Indiana;IA Iowa;KS Kansas;KY Kentucky;LA Louisiana;ME Maine;MD Maryland;MA Massachusetts;MI Michigan;MN Minnesota;MS Mississippi;MO Missouri;MT Montana;NE Nebraska;NV Nevada;NH New Hampshire;NJ New Jersey;NM New Mexico;NY New York;NC North Carolina;ND North Dakota;OH Ohio;OK Oklahoma;OR Oregon;PA Pennsylvania;RI Rhode Island;SC South Carolina;SD South Dakota;TN Tennessee;TX Texas;UT Utah;VT Vermont;VA Virginia;WA Washington;WV West Virginia;WI Wisconsin;WY Wyoming;DC District of Columbia"""

# Municipalities of the Munich metropolitan area (shown as "Munich area" between city and state)
MUNICH_AREA = ['Munich', 'Garching', 'Ottobrunn', 'Taufkirchen', 'Haar', 'Gilching', 'Oberpfaffenhofen', 'Weßling', 'Germering', 'Starnberg', 'Planegg',
               'Martinsried', 'Aschheim', 'Feldkirchen', 'Unterföhring', 'Ismaning', 'Neuried', 'Putzbrunn', 'Hohenbrunn', 'Parsdorf', 'Vaterstetten',
               'Unterschleißheim', 'Fürstenfeldbruck', 'Puchheim', 'Gräfelfing', 'Grünwald', 'Pullach', 'Neubiberg', 'Kirchheim', 'Oberding', 'Gauting',
               'Stockdorf', 'Freising', 'Dachau', 'Eching', 'Karlsfeld', 'Hallbergmoos', 'Poing', 'Grasbrunn', 'Brunnthal', 'Höhenkirchen-Siegertsbrunn',
               'Garbsen', ]
MUNICH_AREA = [c for c in MUNICH_AREA if c != 'Garbsen']

# country | state (or '') | city | aliases (; separated, lower case, optional). City names are matched as whole words.
_CITIES = """
DE|Bavaria|Munich|munich;münchen;muenchen;munchen;munic
DE|Bavaria|Garching|garching;garching bei münchen;garching b. münchen
DE|Bavaria|Ottobrunn|ottobrunn
DE|Bavaria|Taufkirchen|taufkirchen
DE|Bavaria|Haar|haar
DE|Bavaria|Gilching|gilching
DE|Bavaria|Oberpfaffenhofen|oberpfaffenhofen
DE|Bavaria|Weßling|weßling;wessling;weßling bei münchen
DE|Bavaria|Germering|germering
DE|Bavaria|Starnberg|starnberg
DE|Bavaria|Planegg|planegg
DE|Bavaria|Martinsried|martinsried
DE|Bavaria|Aschheim|aschheim
DE|Bavaria|Feldkirchen|feldkirchen
DE|Bavaria|Unterföhring|unterföhring;unterfoehring
DE|Bavaria|Ismaning|ismaning
DE|Bavaria|Neuried|neuried
DE|Bavaria|Putzbrunn|putzbrunn
DE|Bavaria|Hohenbrunn|hohenbrunn
DE|Bavaria|Parsdorf|parsdorf
DE|Bavaria|Vaterstetten|vaterstetten
DE|Bavaria|Unterschleißheim|unterschleißheim
DE|Bavaria|Fürstenfeldbruck|fürstenfeldbruck
DE|Bavaria|Puchheim|puchheim
DE|Bavaria|Gräfelfing|gräfelfing
DE|Bavaria|Grünwald|grünwald
DE|Bavaria|Pullach|pullach
DE|Bavaria|Neubiberg|neubiberg
DE|Bavaria|Oberding|oberding
DE|Bavaria|Gauting|gauting
DE|Bavaria|Stockdorf|stockdorf
DE|Bavaria|Freising|freising
DE|Bavaria|Dachau|dachau
DE|Bavaria|Eching|eching
DE|Bavaria|Augsburg|augsburg
DE|Bavaria|Nuremberg|nuremberg;nürnberg;nuernberg
DE|Bavaria|Erlangen|erlangen
DE|Bavaria|Ingolstadt|ingolstadt
DE|Bavaria|Manching|manching
DE|Bavaria|Schrobenhausen|schrobenhausen
DE|Bavaria|Regensburg|regensburg
DE|Bavaria|Schierling|schierling
DE|Bavaria|Würzburg|würzburg
DE|Bavaria|Kaufbeuren|kaufbeuren
DE|Bavaria|Donauwörth|donauwörth
DE|Bavaria|Straubing|straubing
DE|Bavaria|Landshut|landshut
DE|Bavaria|Rosenheim|rosenheim
DE|Bavaria|Immenstadt|immenstadt
DE|Bavaria|Kronach|kronach
DE|Bavaria|Altenstadt|altenstadt
DE|Bavaria|Peißenberg|peißenberg
DE|Bavaria|Lindenberg|lindenberg im allgäu;lindenberg
DE|Bavaria|Gundremmingen|gundremmingen
DE|Bavaria|Kempten|kempten
DE|Bavaria|Bayreuth|bayreuth
DE|Bavaria|Passau|passau
DE|Bavaria|Bamberg|bamberg
DE|Bavaria|Neuburg an der Donau|neuburg an der donau
DE|Bavaria|Garmisch-Partenkirchen|garmisch-partenkirchen
DE|Berlin|Berlin|berlin
DE|Hamburg|Hamburg|hamburg
DE|Bremen|Bremen|bremen
DE|Baden-Württemberg|Stuttgart|stuttgart;stuttgart-vaihingen
DE|Baden-Württemberg|Karlsruhe|karlsruhe
DE|Baden-Württemberg|Friedrichshafen|friedrichshafen
DE|Baden-Württemberg|Göppingen|göppingen
DE|Baden-Württemberg|Neuenstadt am Kocher|neuenstadt am kocher
DE|Baden-Württemberg|Ulm|ulm
DE|Baden-Württemberg|Heidelberg|heidelberg
DE|Baden-Württemberg|Mannheim|mannheim
DE|Baden-Württemberg|Freiburg|freiburg
DE|Baden-Württemberg|Lampoldshausen|lampoldshausen
DE|Baden-Württemberg|Oberkochen|oberkochen
DE|Baden-Württemberg|Ravensburg|ravensburg
DE|Baden-Württemberg|Immenstaad|immenstaad
DE|Hesse|Darmstadt|darmstadt
DE|Hesse|Frankfurt|frankfurt;frankfurt am main
DE|Hesse|Wiesbaden|wiesbaden
DE|Hesse|Kassel|kassel
DE|North Rhine-Westphalia|Cologne|cologne;köln;koeln
DE|North Rhine-Westphalia|Aachen|aachen
DE|North Rhine-Westphalia|Bonn|bonn
DE|North Rhine-Westphalia|Düsseldorf|düsseldorf;dusseldorf
DE|North Rhine-Westphalia|Dortmund|dortmund
DE|North Rhine-Westphalia|Essen|essen
DE|North Rhine-Westphalia|Remscheid|remscheid
DE|North Rhine-Westphalia|Korschenbroich|korschenbroich
DE|North Rhine-Westphalia|Mönchengladbach|mönchengladbach
DE|North Rhine-Westphalia|Bochum|bochum
DE|Lower Saxony|Hanover|hanover;hannover
DE|Lower Saxony|Laatzen|laatzen
DE|Lower Saxony|Braunschweig|braunschweig;brunswick
DE|Lower Saxony|Göttingen|göttingen
DE|Lower Saxony|Wolfsburg|wolfsburg
DE|Lower Saxony|Oldenburg|oldenburg
DE|Schleswig-Holstein|Kiel|kiel
DE|Schleswig-Holstein|Flintbek|flintbek
DE|Schleswig-Holstein|Lübeck|lübeck
DE|Mecklenburg-Western Pomerania|Rostock|rostock
DE|Mecklenburg-Western Pomerania|Wismar|wismar
DE|Saxony|Dresden|dresden
DE|Saxony|Leipzig|leipzig
DE|Thuringia|Jena|jena
DE|Rhineland-Palatinate|Mainz|mainz
DE|Rhineland-Palatinate|Koblenz|koblenz
DE|Saarland|Saarbrücken|saarbrücken
DE|Brandenburg|Potsdam|potsdam
DE|Hesse|Lichtenau|lichtenau
AT|Vienna|Vienna|vienna;wien
AT||Graz|graz
AT||Linz|linz
AT||Salzburg|salzburg
CH||Zurich|zurich;zürich
CH||Geneva|geneva;genf;geneve;genève
CH||Stans|stans
CH||Emmen|emmen
CH||Payerne|payerne
CH||Lausanne|lausanne;renens
CH||Lucerne|lucerne;luzern
CH||Basel|basel
CH||Bern|bern;berne
CH||Zug|zug
FR||Paris|paris;paris - la défense;la défense;saint-cloud;meudon;meudon la foret;saint-germain-en-laye;massy;palaiseau;vélizy-villacoublay;velizy
FR||Toulouse|toulouse;blagnac
FR||Bordeaux|bordeaux;mérignac;merignac
FR||Lyon|lyon
FR||Rennes|rennes
FR||Marseille|marseille
FR||Vernon|vernon
FR||Cannes|cannes
FR||Nice|nice
FR||Kourou|kourou
FR||Les Mureaux|les mureaux
IT||Turin|turin;torino
IT||Rome|rome;roma
IT||Milan|milan;milano;segrate
IT||Naples|naples;napoli
IT||Bologna|bologna
IT||Genoa|genoa;genova
ES||Madrid|madrid
ES||Barcelona|barcelona
ES||Seville|seville;sevilla
ES||Valencia|valencia
ES||Bilbao|bilbao
PT||Lisbon|lisbon;lisboa
PT||Porto|porto
NL||Noordwijk|noordwijk
NL||Delft|delft
NL||Amsterdam|amsterdam
NL||Eindhoven|eindhoven;veldhoven
NL||Hengelo|hengelo
NL||Haarlem|haarlem
NL||Katwijk|katwijk;katwijk aan zee
NL||Born|born
NL||Rotterdam|rotterdam
NL||Leiden|leiden
NL||Enschede|enschede
BE||Brussels|brussels;bruxelles;brussel
BE||Antwerp|antwerp;antwerpen;hoboken
BE||Mechelen|mechelen
BE||Leuven|leuven
BE||Liège|liège;liege
LU||Luxembourg|luxembourg
IE||Dublin|dublin
IE||Galway|galway
IE||Cork|cork
GB||London|london
GB||Didcot|didcot;harwell;oxfordshire
GB||Oxford|oxford
GB||Cambridge|cambridge
GB||Glasgow|glasgow
GB||Edinburgh|edinburgh
GB||Bristol|bristol
GB||Farnborough|farnborough
GB||Milton Keynes|milton keynes
GB||Plymouth|plymouth
GB||Llanbedr|llanbedr
GB||Guildford|guildford
GB||Reading|reading
GB||Belfast|belfast
GB||Leicester|leicester
GB||Shetland Islands|shetland islands;shetland
DK||Copenhagen|copenhagen;københavn
DK||Aalborg|aalborg
SE||Stockholm|stockholm
SE||Kiruna|kiruna
SE||Gothenburg|gothenburg;göteborg
SE||Linköping|linköping
NO||Oslo|oslo
NO||Andenes|andenes
NO||Kongsberg|kongsberg
FI||Espoo|espoo
FI||Helsinki|helsinki
FI||Tampere|tampere
PL||Warsaw|warsaw;warszawa
PL||Bydgoszcz|bydgoszcz
PL||Krakow|krakow;kraków
PL||Gdansk|gdansk;gdańsk
CZ||Prague|prague;praha
CZ||Brno|brno
HU||Budapest|budapest
RO||Bucharest|bucharest
GR||Athens|athens;pallini
GR||Thessaloniki|thessaloniki
SI||Ljubljana|ljubljana
HR||Zagreb|zagreb
EE||Tallinn|tallinn
LT||Vilnius|vilnius
BG||Sofia|sofia
US|California|Los Angeles|los angeles;la
US|California|Hawthorne|hawthorne
US|California|Long Beach|long beach
US|California|Costa Mesa|costa mesa
US|California|El Segundo|el segundo
US|California|Irvine|irvine
US|California|Santa Ana|santa ana
US|California|San Diego|san diego
US|California|San Francisco|san francisco
US|California|San Jose|san jose
US|California|Mountain View|mountain view
US|California|Sunnyvale|sunnyvale
US|California|Palo Alto|palo alto
US|California|Burlingame|burlingame
US|California|San Carlos|san carlos
US|California|San Mateo|san mateo
US|California|Pasadena|pasadena
US|California|Redlands|redlands
US|California|Vandenberg|vandenberg;vandenberg sfb
US|California|Mojave|mojave
US|California|Folsom|folsom
US|California|Pleasanton|pleasanton
US|California|Culver City|culver city
US|California|Victorville|victorville
US|California|San Clemente|san clemente
US|California|Goleta|goleta
US|California|Dublin|dublin, ca
US|California|Santa Clara|santa clara
US|California|Edwards|edwards
US|Texas|Bastrop|bastrop
US|Texas|Starbase|starbase;boca chica
US|Texas|Austin|austin
US|Texas|Dallas|dallas
US|Texas|Midland|midland
US|Texas|McGregor|mcgregor
US|Texas|College Station|college station
US|Texas|Houston|houston
US|Texas|San Antonio|san antonio
US|Texas|Fort Stockton|fort stockton
US|Texas|Webster|webster
US|Texas|Anderson|anderson
US|Washington|Redmond|redmond
US|Washington|Seattle|seattle;greater seattle area
US|Washington|Kent|kent
US|Washington|Woodinville|woodinville
US|Washington|Tukwila|tukwila
US|Washington|Bellevue|bellevue
US|Washington|Olympia|olympia
US|Colorado|Westminster|westminster
US|Colorado|Louisville|louisville
US|Colorado|Denver|denver;greater denver area
US|Colorado|Littleton|littleton
US|Colorado|Golden|golden
US|Colorado|Boulder|boulder
US|Colorado|Berthoud|berthoud
US|Colorado|Broomfield|broomfield
US|Colorado|Centennial|centennial
US|Colorado|Englewood|englewood
US|Colorado|Fort Collins|fort collins
US|Colorado|Longmont|longmont
US|Colorado|Pueblo|pueblo
US|Colorado|Penrose|penrose
US|Colorado|Colorado Springs|colorado springs
US|Florida|Cape Canaveral|cape canaveral;space coast;merritt island;titusville
US|Florida|Melbourne|melbourne, fl
US|Florida|Homestead|homestead
US|Florida|Jacksonville|jacksonville
US|Florida|Sarasota|sarasota
US|Florida|Miami|miami
US|Florida|Orlando|orlando
US|Virginia|Reston|reston
US|Virginia|Vienna|vienna, va
US|Virginia|Wallops Island|wallops island;wallops
US|Virginia|Chantilly|chantilly
US|Virginia|Arlington|arlington
US|Virginia|Herndon|herndon
US|Virginia|McLean|mclean
US|Virginia|Sterling|sterling
US|District of Columbia|Washington D.C.|washington dc;washington d.c;district of columbia
US|Massachusetts|Waltham|waltham
US|Massachusetts|Boston|boston
US|Massachusetts|Lexington|lexington
US|Massachusetts|Quincy|quincy
US|Massachusetts|Cambridge|cambridge, ma
US|Ohio|Ashville|ashville
US|Ohio|Columbus|columbus
US|Rhode Island|Quonset|quonset
US|Mississippi|Stennis Space Center|stennis space center;stennis
US|Mississippi|McHenry|mchenry
US|Maryland|Lanham|lanham
US|Maryland|Aberdeen|aberdeen
US|Maryland|Rockville|rockville
US|Maryland|Bethesda|bethesda
US|Maryland|Baltimore|baltimore
US|Alabama|Huntsville|huntsville
US|Alabama|Trinity|trinity
US|Georgia|Atlanta|atlanta
US|Georgia|Chamblee|chamblee
US|New York|New York|new york city;new york;nyc
US|New York|Canandaigua|canandaigua
US|New York|Pittsford|pittsford
US|New York|Endicott|endicott
US|New York|Rochester|rochester
US|New Jersey|Iselin|iselin
US|New Hampshire|Hudson|hudson
US|Nevada|Reno|reno
US|North Carolina|Morrisville|morrisville
US|North Carolina|Raleigh|raleigh
US|New Mexico|Albuquerque|albuquerque
US|Michigan|Detroit|detroit
US|Oklahoma|Tulsa|tulsa
US|Arizona|Phoenix|phoenix;tucson
US|Utah|Salt Lake City|salt lake city
US|Illinois|Chicago|chicago
CA||Montreal|montreal;montréal
CA||Ottawa|ottawa
CA||Toronto|toronto
CA||Vancouver|vancouver
CA|Nova Scotia|Canso|canso
AU||Sydney|sydney
AU||Melbourne|melbourne
AU||Brisbane|brisbane
AU||Adelaide|adelaide
AU||Canberra|canberra
AU||Perth|perth
AU||Gold Coast|gold coast
AU||Bowen|bowen
NZ||Auckland|auckland
NZ||Christchurch|christchurch
NZ||Wellington|wellington
NZ||Mahia|mahia
NZ||Waikato|waikato
SG||Singapore|singapore;bulim square
AE||Abu Dhabi|abu dhabi
AE||Dubai|dubai
AE||Sharjah|sharjah
SA||Riyadh|riyadh
QA||Doha|doha
IL||Tel Aviv|tel aviv
IN||Bengaluru|bengaluru;bangalore
IN||Hyderabad|hyderabad
IN||Mumbai|mumbai
IN||New Delhi|new delhi;delhi
JP||Tokyo|tokyo;sumida-ku
JP||Osaka|osaka
CN||Shanghai|shanghai
CN||Beijing|beijing
CN||Shenzhen|shenzhen
TW||Taipei|taipei
KR||Seoul|seoul
HK||Hong Kong|hong kong
BR||São Paulo|são paulo;sao paulo
MX||Mexico City|mexico city
ZA||Johannesburg|johannesburg
ZA||Cape Town|cape town
"""

REMOTE_RE = re.compile(r'\b(remote|hybrid|on-?site|onsite|home ?office|work from home|wfh|telework|anywhere|virtual)\b', re.I)
NOISE_RE = re.compile(r'\b(hq|headquarters|office|offices|workplace|other locations?|entry level|workplace|facility|manufacturing & testing|undisclosed test site)\b', re.I)
STRONG_SPLIT = re.compile(r'\s*(?:;|\||•|·|\s/\s|\s-\s|\s+or\s+|\s+OR\s+|\s&\s|\s+and\s|\s*/\s*(?=[A-Z]))\s*')

_STOP_PLACE = {'unspecified', 'n/a', 'na', 'tbd', 'all offices', 'global', 'worldwide', 'multiple locations', 'various', 'flexible', ''}
_WORLD = {'global', 'worldwide', 'international', 'anywhere'}


def _fold(s):
    return unicodedata.normalize('NFKD', s).encode('ascii', 'ignore').decode('ascii').lower()


def _norm(s):
    s = _fold(s.replace('ß', 'ss'))
    return re.sub(r'\s+', ' ', re.sub(r"[^a-z0-9 ,.'&-]", ' ', s)).strip()


# ---------------------------------------------------------------------------------------------------- tables
COUNTRY = {}          # code -> {'en','de','continent'}
_COUNTRY_ALIAS = {}   # alias -> code
for _line in _COUNTRIES.strip().splitlines():
    code, en, de, cont, aliases = _line.split('|')
    COUNTRY[code] = {'en': en, 'de': de, 'continent': cont}
    for a in aliases.split(';'):
        _COUNTRY_ALIAS[_norm(a)] = code
    _COUNTRY_ALIAS[_norm(en)] = code

_ISO2_PLAIN = ('AT BE CH CZ DK EE ES FI FR GB GR HR HU IE IT LT LU LV NL NO PL PT RO SE SI SK AU NZ JP CN KR SG HK TW AE BR MX ZA').split()
for _c in _ISO2_PLAIN:
    _COUNTRY_ALIAS.setdefault(_c.lower(), _c)
_ISO2_AMBIGUOUS = {'de': 'DE', 'in': 'IN', 'ca': 'CA', 'ar': 'AR', 'co': 'CO', 'id': 'ID', 'il': 'IL', 'mt': 'MT'}   # also US state codes

STATE = {}            # (country, state EN) -> German name
_STATE_ALIAS = {}     # alias -> list of (country, state EN)
for _line in _STATES.strip().splitlines():
    parts = _line.split('|')
    cc, en, de, aliases = parts[0], parts[1], parts[2], parts[3]
    STATE[(cc, en)] = de
    for a in set(aliases.split(';') + [en, de]):
        if len(a) <= 3 and a.lower() not in ('nsw', 'qld', 'nrw'):   # "WA" is Washington, "ON"/"BC"/"NS"/"ACT" are too ambiguous as bare codes
            continue
        _STATE_ALIAS.setdefault(_norm(a), []).append((cc, en))
_US_ABBR = {}
for _item in _US_STATES.split(';'):
    ab, name = _item.split(' ', 1)
    _US_ABBR[ab.lower()] = name
    STATE[('US', name)] = name
    _STATE_ALIAS.setdefault(_norm(name), []).append(('US', name))
# two-letter German state codes only count next to a German context, so they are not general aliases
_DE_CODE = {'by': 'Bavaria', 'bw': 'Baden-Württemberg', 'nw': 'North Rhine-Westphalia', 'he': 'Hesse', 'ni': 'Lower Saxony', 'sn': 'Saxony', 'th': 'Thuringia'}

CITY = {}             # (country, city) -> state
_CITY_ALIAS = {}      # alias (normalised) -> (city, state, country)
for _line in sorted(_CITIES.strip().splitlines(), key=lambda l: l.startswith('US|')):   # a bare ambiguous name (Melbourne, Cambridge) means the non-US city; "Melbourne, FL" still resolves to the US one
    cc, state, city, aliases = _line.split('|')
    CITY[(cc, city)] = state
    for a in set(aliases.split(';') + [city]):
        _CITY_ALIAS.setdefault(_norm(a).strip(' ,.-'), (city, state, cc))

# GeoNames gazetteer (jobcrawl/geo/build_gazetteer.py, build time only): about 83k places. It only fills what the hand tables above do not know, and only
# as whole-token names, never inside longer text. A bare name shared by several countries needs a clear winner (3x the population of the runner-up);
# otherwise it stays unknown and takes its country from the text around it, as before.
GAZ = {}              # alias (normalised) -> (city, state, country), unambiguous names only
_GAZ_LL = {}          # "CC|City" -> [lat, lon]


def _load_gazetteer():
    import csv
    import gzip
    import os
    p = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'gazetteer.tsv.gz')
    try:
        fh = gzip.open(p, 'rt', encoding='utf-8')
    except OSError:
        return
    state_by_name = {(cc, _norm(en)): en for (cc, en) in STATE}
    by_name = {}
    with fh:
        for ascii_name, name, cc, admin1, pop, lat, lon in csv.reader(fh, delimiter='\t'):
            if cc not in COUNTRY:
                continue
            state = state_by_name.get((cc, _norm(admin1)), '')
            _GAZ_LL.setdefault(f'{cc}|{ascii_name}', [float(lat), float(lon)])
            by_name.setdefault(_norm(ascii_name).strip(' ,.-'), []).append((int(pop), ascii_name, state, cc))
    for key, cands in by_name.items():
        if len(key) < 4 or key in _CITY_ALIAS or key in _COUNTRY_ALIAS or key in _STATE_ALIAS or key in _ISO2_AMBIGUOUS or key in _STOP_PLACE:
            continue
        cands.sort(reverse=True)
        if len(cands) > 1 and cands[0][0] < 3 * cands[1][0] and cands[0][3] != cands[1][3]:
            continue
        _, city, state, cc = cands[0]
        GAZ[key] = (city, state, cc)


_load_gazetteer()
_GAZ_TUPLES = set(GAZ.values())
_AREA = {c for c in MUNICH_AREA}
_CITY_KEYS = sorted(_CITY_ALIAS, key=len, reverse=True)
_CITY_RE = {k: re.compile(r'(?<![a-z0-9])' + re.escape(k) + r'(?![a-z0-9])') for k in _CITY_KEYS}

CITY_DE = {'Munich': 'München', 'Nuremberg': 'Nürnberg', 'Cologne': 'Köln', 'Hanover': 'Hannover', 'Vienna': 'Wien', 'Rome': 'Rom', 'Milan': 'Mailand',
           'Turin': 'Turin', 'Naples': 'Neapel', 'Geneva': 'Genf', 'Zurich': 'Zürich', 'Lisbon': 'Lissabon', 'Brussels': 'Brüssel', 'Antwerp': 'Antwerpen',
           'Prague': 'Prag', 'Warsaw': 'Warschau', 'Copenhagen': 'Kopenhagen', 'Athens': 'Athen', 'Seville': 'Sevilla', 'Lucerne': 'Luzern',
           'Gothenburg': 'Göteborg', 'Bucharest': 'Bukarest', 'Hong Kong': 'Hongkong', 'Singapore': 'Singapur', 'Tokyo': 'Tokio'}


def _place(city='', state='', country='', area=''):
    p = {'city': city, 'area': area, 'state': state, 'country': country, 'continent': COUNTRY[country]['continent'] if country in COUNTRY else ''}
    if city in _AREA and country == 'DE' and state == 'Bavaria':
        p['area'] = 'Munich area'
    return p


def _token_kind(tok):
    """Classify one comma-separated token: ('country', code) | ('state', (cc, name)) | ('city', (city, state, cc)) | ('continent', code) | ('unknown', text)."""
    t = _norm(tok)
    t = re.sub(r'\b\d{4,6}\b', ' ', t)                       # postcodes
    t = re.sub(r'\(.*?\)', ' ', t)
    t = re.sub(r'\s+', ' ', t).strip(' ,.-')
    if not t or t in _STOP_PLACE:
        return ('empty', '')
    if t in ('europe', 'europa', 'emea', 'european union', 'eu', 'eea'):
        return ('continent', 'EU')
    if t in _ISO2_AMBIGUOUS:
        return ('amb', t)
    if t in _COUNTRY_ALIAS:
        return ('country', _COUNTRY_ALIAS[t])
    if t in _CITY_ALIAS and not (t in _STATE_ALIAS and _CITY_ALIAS[t][1] == '' and t in ('georgia',)):
        return ('city', _CITY_ALIAS[t])
    if t in _STATE_ALIAS:
        return ('state', _STATE_ALIAS[t][0] if len(_STATE_ALIAS[t]) == 1 else _STATE_ALIAS[t])
    if t in _US_ABBR:
        return ('state', ('US', _US_ABBR[t]))
    if t in GAZ:
        return ('city', GAZ[t])
    # a city name inside a longer token ("QFI Gilching", "Weßling bei München", "Munich Hybrid"): the earliest known name wins
    best = None
    for k in _CITY_KEYS:
        m = _CITY_RE[k].search(t)
        if m and (best is None or m.start() < best[0]):
            best = (m.start(), k)
    if best:
        return ('city', _CITY_ALIAS[best[1]])
    return ('unknown', t)


def _split_places(text):
    text = re.sub(r'&nbsp;|_', ' ', text)
    text = REMOTE_RE.sub(' ', text)
    text = NOISE_RE.sub(' ', text)
    text = re.sub(r'[()]', '¦', text)   # "Charleroi (Belgium)", "Garching b. München (DE)": the bracketed part is context for the place before it
    parts = [p for p in STRONG_SPLIT.split(text) if p and p.strip(' ,.-')]
    return parts


def _assemble(piece, hint_country=''):
    """One strong-separated piece (comma separated tokens) -> one place, or None."""
    toks = [t for t in re.split(r'[,¦]', piece) if t.strip()]
    kinds = [k for k in (_token_kind(t) for t in toks) if k[0] != 'empty']
    if not kinds:
        return None
    # "CA", "DE", "IN"...: a US state when anything else says United States, otherwise the country (or Canada/Germany/India)
    us_evidence = any((k[0] == 'country' and k[1] == 'US') or (k[0] == 'state' and (k[1][0] if isinstance(k[1], tuple) else k[1][0][0]) == 'US')
                      or (k[0] == 'city' and k[1][2] == 'US') for k in kinds)
    resolved = []
    for k in kinds:
        if k[0] == 'amb':
            code = k[1]
            home = _ISO2_AMBIGUOUS[code]
            for_country = any((x[0] == 'city' and x[1][2] == home) or (x[0] == 'country' and x[1] == home) for x in kinds)
            if code in _US_ABBR and (us_evidence or (code != 'de' and not for_country)):
                k = ('state', ('US', _US_ABBR[code]))
            else:
                k = ('country', _ISO2_AMBIGUOUS[code])
        resolved.append(k)
    kinds = resolved
    hard = next((k[1] for k in kinds if k[0] == 'country'), '')
    # a gazetteer city that contradicts a country typed in the same place ("Sainte-Anne-de-Bellevue, QC, Canada" is not Bellevue, WA)
    # is a coincidence of names: keep the typed text as the city instead
    if hard:
        kinds = [('unknown', _norm(t).strip(' ,.-')) if (k[0] == 'city' and k[1][2] != hard) else k for t, k in zip([t for t in toks if _token_kind(t)[0] != 'empty'], kinds)] if len(kinds) == len([t for t in toks if _token_kind(t)[0] != 'empty']) else kinds
    city = state = ''
    soft = ''
    from_gaz = False
    for k in kinds:
        if k[0] == 'city' and not city:
            city, st, soft = k[1]
            state = st
            from_gaz = k[1] in _GAZ_TUPLES   # a gazetteer city guessed its state from population; a state typed in the text wins
    country = hard or soft
    for k in kinds:
        if k[0] != 'state':
            continue
        cands = k[1] if isinstance(k[1], list) else [k[1]]
        pick = next((c for c in cands if c[0] == hard), None) if hard else None
        if pick is None and not hard:
            pick = next((c for c in cands if c[0] == soft), None) or cands[0]
            if soft and pick[0] != soft:   # "Dublin, CA": the typed state beats the country the city name suggests
                state, country = '', pick[0]
        if pick is None:
            continue
        if not state or state != pick[1] and (not city or pick[0] != soft or from_gaz):
            state = pick[1]
        country = country or pick[0]
    unknown = [k[1] for k in kinds if k[0] == 'unknown']
    if not city and unknown and (country or state):
        city = unknown[0].title()
    if not country and not city and not state:
        if any(k[0] == 'continent' for k in kinds):
            return {'city': '', 'area': '', 'state': '', 'country': '', 'continent': 'EU'}
        return None
    return _place(city, state, country or hint_country)


def _context_of(kinds):
    """(country, state) carried by a piece that names only states, countries or a continent."""
    country = next((k[1] for k in kinds if k[0] == 'country'), '')
    state = ''
    for k in kinds:
        if k[0] == 'state':
            cands = k[1] if isinstance(k[1], list) else [k[1]]
            pick = next((c for c in cands if not country or c[0] == country), None)
            if pick:
                state, country = pick[1], country or pick[0]
    return {'country': country, 'state': state, 'continent': any(k[0] == 'continent' for k in kinds)}


def _fits(place, ctx):
    """A context piece continues `place` when it does not contradict it."""
    return ((not ctx['country'] or not place['country'] or ctx['country'] == place['country'])
            and (not ctx['state'] or not place['state'] or ctx['state'] == place['state']))


def _comma_groups(piece):
    """"Karlsruhe, Baden-Württemberg, Germany, München, Bavaria, Germany" -> two groups, each city taking the state/country that follows it."""
    groups, cur, has_city = [], [], False
    for ch in piece.split(','):
        if not ch.strip(' ¦'):
            continue
        is_city = _token_kind(ch.split('¦')[0])[0] == 'city'
        if is_city and has_city:
            groups.append(cur)
            cur, has_city = [], False
        cur.append(ch)
        has_city = has_city or is_city
    if cur:
        groups.append(cur)
    return [','.join(g) for g in groups]


def resolve(text, fallback_text=''):
    return copy.deepcopy(_resolve_cached(text, fallback_text))


@functools.lru_cache(maxsize=4096)
def _resolve_cached(text, fallback_text=''):
    """-> {'places': [...], 'primary': place|None, 'remote': bool, 'inferred': bool, 'level': 'city'|'state'|'country'|'continent'|'none'}"""
    raw = html.unescape((text or '').strip())
    remote = bool(REMOTE_RE.search(raw))
    raw = re.sub(r'washington,?\s*(?:d\.?\s?c\.?|district of columbia)', 'Washington DC', raw, flags=re.I)
    # "US-NY-Farmingdale (Sensors)" -> "Farmingdale, NY, USA"; "Santa Rosa, CA USA" and "USA Saint Louis MO" -> comma-separated state and country
    raw = re.sub(r'\bUS-([A-Z]{2})-([^()|;/]+)', lambda m: f'{m.group(2).strip()}, {m.group(1)}, USA', raw)
    raw = re.sub(r',\s*([A-Z]{2})\s+(?:USA|US|United States)\b', r', \1, USA', raw)
    raw = re.sub(r'\bUSA\s+([A-Z][\w. ]+?)\s+([A-Z]{2})\b(?!\w)', r'\1, \2, USA', raw)
    places, pending, lead = [], [], None
    pieces = [g for p in _split_places(raw) for g in _comma_groups(p)]
    for piece in pieces:
        kinds = [k for k in (_token_kind(t) for t in re.split(r'[,¦]', piece) if t.strip()) if k[0] != 'empty']
        if not kinds:
            continue
        if all(k[0] == 'unknown' for k in kinds):
            pending.append(kinds[0][1].title())
            continue
        if all(k[0] in ('state', 'country', 'continent') for k in kinds):
            ctx = _context_of(kinds)
            if pending:   # "Seefeld / Inning / Bavaria / Germany": the names collected so far get this context
                for name in pending:
                    places.append(_place(name, ctx['state'], ctx['country']))
                pending = []
            elif places and _fits(places[-1], ctx):
                last = places[-1]
                last['country'] = last['country'] or ctx['country']
                last['state'] = last['state'] or ctx['state']
            elif places and ctx['continent'] and not ctx['country']:
                pass   # "... / Europe" after real places adds nothing
            elif not places and lead is None:
                lead = ctx
            else:
                places.append(_place('', ctx['state'], ctx['country']))
                if ctx['continent'] and not ctx['country']:
                    places[-1]['continent'] = 'EU'
            continue
        pl = _assemble(piece, '')
        if not pl:
            continue
        if lead:   # "USA - San Francisco", "Japan; Tokyo"
            if (not lead['country'] or not pl['country'] or lead['country'] == pl['country']) and (not lead['state'] or not pl['state'] or lead['state'] == pl['state']):
                pl['country'] = pl['country'] or lead['country']
                pl['state'] = pl['state'] or lead['state']
            elif lead['country'] or lead['state']:
                places.append(_place('', lead['state'], lead['country']))
            lead = None
        places.append(pl)
    if lead and (lead['country'] or lead['state'] or lead['continent']):
        pl = _place('', lead['state'], lead['country'])
        if lead['continent'] and not lead['country']:
            pl['continent'] = 'EU'
        places.append(pl)
    uniq = []
    for pl in places:
        if pl['country'] in COUNTRY:
            pl['continent'] = COUNTRY[pl['country']]['continent']
        if pl.get('city') in _AREA and pl['country'] == 'DE' and pl['state'] == 'Bavaria':
            pl['area'] = 'Munich area'
        # "Gräfelfing / Munich / Germany": the metropolis named after a suburb of it is the suburb's context, not a second place
        if pl['city'] == 'Munich' and any(p['area'] == 'Munich area' and p['city'] != 'Munich' for p in uniq):
            continue
        if not any((p['city'], p['state'], p['country']) == (pl['city'], pl['state'], pl['country']) for p in uniq):
            uniq.append(pl)
    places = uniq
    if any(p['country'] or p['city'] for p in places):
        places = [p for p in places if p['country'] or p['city']]
    inferred = False
    if not places and fallback_text:
        fb = resolve(fallback_text)
        if fb['places']:
            places, inferred = fb['places'][:1], True
    primary = places[0] if places else None
    level = 'none'
    if primary:
        level = 'city' if primary['city'] else ('state' if primary['state'] else ('country' if primary['country'] else 'continent'))
    return {'places': places[:4], 'primary': primary, 'remote': remote, 'inferred': inferred, 'level': level}


def display(g):
    """One canonical, consistent label for a resolved geo: "Munich, Bavaria", "Augsburg, Bavaria", "Madrid, Spain", "Singapore"; several places
    read "Munich, Bavaria +2". Empty when nothing resolved (the caller keeps the posting's own text)."""
    def one(p):
        if p['city']:
            tail = p['state'] if p['state'] and p['country'] in ('DE', 'US', 'CA', 'AU', 'AT', 'CH', 'IN', 'BR', 'MX') else (COUNTRY.get(p['country'], {}).get('en', '') if p['country'] else '')
            if p['city'] == tail or p['country'] == 'SG':
                tail = ''
            return f"{p['city']}, {tail}" if tail else p['city']
        if p['state']:
            return f"{p['state']}, {COUNTRY[p['country']]['en']}" if p['country'] in COUNTRY else p['state']
        if p['country'] in COUNTRY:
            return COUNTRY[p['country']]['en']
        return 'Europe' if p.get('continent') == 'EU' else ''
    places = [pl for pl in g.get('places', []) if one(pl)]
    if not places:
        return ''
    first = one(places[0])
    return first + (f' +{len(places) - 1}' if len(places) > 1 else '')


def scopes_of(geo):
    """The board's search scopes: bavaria < germany < europe < worldwide. A role listed in several places is in the union of their scopes.
    A place inferred from the employer's headquarters does not count: only what the posting itself says."""
    if geo.get('inferred'):
        return ['worldwide']
    out = {'worldwide'}
    for p in geo.get('places', []):
        if p['country'] == 'DE':
            out |= {'germany', 'europe'}
            if p['state'] == 'Bavaria':
                out.add('bavaria')
        elif p['continent'] == 'EU':
            out.add('europe')
    return [s for s in ('bavaria', 'germany', 'europe', 'worldwide') if s in out]


_ASIA_PACIFIC = {'JP', 'CN', 'HK', 'TW', 'KR', 'IN', 'TH', 'MY', 'ID', 'VN', 'PH'}
_MIDDLE_EAST = {'AE', 'SA', 'QA', 'IL', 'JO'}


def region_of(geo):
    """One of the board's regions from the explicit places (closest to Munich first), or '' when the posting names none."""
    if geo.get('inferred'):
        return 'Remote' if geo.get('remote') else ''
    places = geo.get('places', [])
    if any(p['country'] == 'DE' and p['state'] == 'Bavaria' for p in places):
        return 'Munich & Bavaria'
    if any(p['country'] == 'DE' for p in places):
        return 'Germany (Other)'
    if any(p['continent'] == 'EU' for p in places):
        return 'Europe'
    for p in places:
        c = p['country']
        if c == 'AU':
            return 'Australia'
        if c == 'NZ':
            return 'New Zealand'
        if c in _MIDDLE_EAST:
            return 'UAE & Middle East'
        if c == 'SG':
            return 'Singapore'
        if c in _ASIA_PACIFIC:
            return 'Japan & Asia-Pacific'
        if c == 'US':
            return 'United States'
    if places:
        return 'Global & Other'
    return 'Remote' if geo.get('remote') else ''


LEVELS = ('city', 'area', 'state', 'country', 'continent', 'world')


def common_level(places):
    """The deepest level at which every place agrees: one place is itself ('city'); Munich + Garching share the 'area'; Munich + Berlin
    the 'country'; Munich + Paris the 'continent'; Munich + Boston only the 'world'. Returns (level, label parts from continent down)."""
    if not places:
        return 'world', []
    def chain(p):   # from the top down
        return [('continent', p['continent']), ('country', p['country']), ('state', p['state']), ('area', p['area']), ('city', p['city'])]
    first = chain(places[0])
    if len(places) == 1:
        deepest = next((lv for lv, v in reversed(first) if v), 'world')
        return deepest, [v for _, v in first if v]
    level, parts = 'world', []
    for (lv, v), *_ in zip(first):
        if not v or any(dict(chain(p)).get(lv) != v for p in places[1:]):
            break
        level, parts = lv, parts + [v]
    return level, parts


def compact(geo):
    """Short form for the feed. p: every place as [city, area, state, country code, continent code]; l: the lowest level they all share
    (city, area, state, country, continent or world); r: remote; i: inferred from the employer's headquarters (no place in the posting)."""
    places = geo.get('places', [])
    out = {}
    if places:
        out['p'] = [[x['city'], x['area'], x['state'], x['country'], x['continent']] for x in places[:6]]
        out['l'] = common_level(places)[0]
    if geo.get('remote'):
        out['r'] = 1
    if geo.get('inferred'):
        out['i'] = 1
    return out


_COORDS = None


def coords():
    """{"CC|City": [lat, lon]} for the gazetteer cities. An optional geo_coords.json next to this file (GeoNames, CC BY 4.0) is read
    first; the coordinates of the gazetteer itself fill in the rest."""
    global _COORDS
    if _COORDS is None:
        import json
        import os
        p = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'geo_coords.json')
        try:
            with open(p, encoding='utf-8') as fh:
                _COORDS = json.load(fh)
        except (OSError, ValueError):
            _COORDS = {}
        for k, v in _GAZ_LL.items():
            _COORDS.setdefault(k, v)
    return _COORDS


def latlons(compact_geo):
    """[[lat, lon], ...] of the city-level places of a compact geo (places only known to state or country have no point and are left out)."""
    c = coords()
    out = []
    for p in (compact_geo or {}).get('p', []):
        ll = c.get(f'{p[3]}|{p[0]}') if p[0] else None
        if ll and ll not in out:
            out.append(ll)
    return out


def area_tokens(compact_geo):
    """Area filter tokens of a role: for every place its continent (k:EU), country (c:DE), state (s:DE:Bavaria) and, for the Munich metropolitan
    area, a:Munich area. A role matches an area when any of its places carries the token."""
    out = []
    for p in (compact_geo or {}).get('p', []):
        city, area, state, cc, cont = (list(p) + [''] * 5)[:5]
        toks = []
        if cont:
            toks.append('k:' + cont)
        if cc:
            toks.append('c:' + cc)
        if state and cc:
            toks.append(f's:{cc}:{state}')
        if area:
            toks.append('a:' + area)
        if city and cc:
            toks.append(f't:{cc}:{city}')
        out += [t for t in toks if t not in out]
    return out


def area_chains(compact_geo):
    """Per place the chain of area tokens from the continent down to the city, e.g. k:EU > c:DE > s:DE:Bavaria > a:Munich area > t:DE:Munich."""
    chains = []
    for p in (compact_geo or {}).get('p', []):
        city, area, state, cc, cont = (list(p) + [''] * 5)[:5]
        ch = []
        if cont:
            ch.append('k:' + cont)
        if cc:
            ch.append('c:' + cc)
        if state and cc:
            ch.append(f's:{cc}:{state}')
        if area:
            ch.append('a:' + area)
        if city and cc:
            ch.append(f't:{cc}:{city}')
        if ch:
            chains.append(ch)
    return chains


def area_label(tok):
    """(English, German) name of an area token."""
    kind, _, rest = tok.partition(':')
    if kind == 'k':
        return CONTINENTS.get(rest, (rest, rest))
    if kind == 'c':
        c = COUNTRY.get(rest)
        return (c['en'], c['de']) if c else (rest, rest)
    if kind == 's':
        cc, _, state = rest.partition(':')
        c = COUNTRY.get(cc)
        de = STATE.get((cc, state), state)
        return (f'{state}', f'{de}')
    if kind == 't':
        city = rest.partition(':')[2]
        return (city, CITY_DE.get(city, city))
    if rest == 'Munich area':
        return ('Munich area', 'Großraum München')
    return (rest, rest)


def tables():
    """Name tables for the browser: countries, continents, states and German city names."""
    return {'countries': {c: [v['en'], v['de']] for c, v in COUNTRY.items()},
            'continents': {c: list(v) for c, v in CONTINENTS.items()},
            'states': {en: de for (cc, en), de in STATE.items() if de != en},
            'cities': CITY_DE}


if __name__ == '__main__':
    import json
    import collections
    cat = json.load(open(sys.argv[1], encoding='utf-8'))
    cnt = collections.Counter((j.get('location') or '').strip() for j in cat)
    levels = collections.Counter()
    bad = []
    for loc, n in cnt.items():
        g = resolve(loc)
        levels[g['level']] += n
        if g['level'] in ('none', 'continent') or (g['primary'] and not g['primary']['country']):
            bad.append((n, loc, g['remote']))
    tot = sum(cnt.values())
    print('roles', tot, '| granularity:', {k: f'{v} ({100 * v / tot:.1f}%)' for k, v in levels.most_common()})
    for n, loc, rem in sorted(bad, reverse=True)[:int(sys.argv[2]) if len(sys.argv) > 2 else 40]:
        print(f'  {n:4d} {loc[:90]!r} remote={rem}')
