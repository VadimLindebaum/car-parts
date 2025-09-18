# car-parts
npm install cors
npm install express-rate-limit
npm install swagger-ui-express yamljs
1.	Save server.js and package.json into a folder. Put your LE.txt (CSV export) in the same folder.
2.	Install packages:
npm install
3.	Start the server:
npm start
4.	Example queries:
Get first page (30 items):
GET http://localhost:3300/spare-parts
•	Page 2:
GET http://localhost:3300/spare-parts?page=2
	•	Search by name (partial, case-insensitive):
GET http://localhost:3300/spare-parts?name=polt
	•	Search by serial number (contains):
GET http://localhost:3300/spare-parts?sn=9745224452
	•	General search (checks name and sn):
GET http://localhost:3300/spare-parts?search=9745224452
	•	Sort by price (cheapest first):
GET http://localhost:3300/spare-parts?sort=price
	•	Sort by price descending:
GET http://localhost:3300/spare-parts?sort=-price
	•	Get by exact serial (fast path):
GET http://localhost:3300/spare-parts/ABC-1234
	•	Manually reload file after new export:
POST http://localhost:3300/reload

Notes & adjustments you may need
	•	Column names: The code tries common header names (name, price, serial_number, sn, etc.). If your CSV uses different headers, either rename CSV header row or adapt normalizeRow() mappings (quick edit).
	•	Encoding & delimiter: csv-parser auto-detects comma delimiter. If your file uses ; or |, pass the separator option to csv() — e.g. csv({ separator: ';' }).
	•	Large file memory: This solution keeps the entire dataset in memory. For a ~600MB CSV the in-memory JS objects may use several GB. If memory becomes an issue, consider:
	•	Storing an index on disk / lookup DB (sqlite, redis) instead of full in-memory objects;
	•	Or compressing/flattening objects to reduce overhead; or using streaming on demand (slower).
	•	Security & production: Add authentication to /reload or remove the endpoint; add rate limiting and request validation for production.
	•	Performance: For very frequent searches by name you could build an inverted index or use a small search engine (Lunr, Elastic, sqlite FTS) — the current approach is simple and OK for modest request volumes.
