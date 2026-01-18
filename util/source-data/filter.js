import fs from 'fs';

const data = JSON.parse(fs.readFileSync('2023-july.geo.json'));

data.features.forEach(f => {
  delete f.properties.featureGroup;
  delete f.properties.source;
})

fs.writeFileSync("2023-july2.geo.json", JSON.stringify(data));

