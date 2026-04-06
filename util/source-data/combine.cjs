const fs = require('fs');
const path = require('path');

function combineJsonFiles(directory, outputFile) {
  const jsonFiles = fs.readdirSync(directory).filter(file => path.extname(file) === '.json');

  const combinedData = {
    type: "FeatureCollection",
    features: []
  };
  jsonFiles.forEach(file => {
    const filePath = path.join(directory, file);
    const data = fs.readFileSync(filePath, 'utf8');
    const jsonData = JSON.parse(data);

    jsonData.features.forEach(f => {
      f.properties.trip = file;
    })

    combinedData.features.push(...jsonData.features);
  });

  fs.writeFileSync(outputFile, JSON.stringify(combinedData));
  console.log(`Combined JSON files into ${outputFile}`);
}

const directoryPath = './'; // Replace with your directory path
const outputFileName = 'combined.geo.json';

combineJsonFiles(directoryPath, outputFileName);