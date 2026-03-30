import { createApp } from "./app";
import { startIndexer } from "./indexer/indexer";
import { startHistoricalYieldAggregationJob } from "./jobs/historicalYieldAggregation";
import { startSharePriceSnapshotJob } from "./jobs/sharePriceSnapshot";
import { startHealthMonitor } from "./monitoring/healthMonitor";

const app = createApp();
const PORT = process.env.PORT || 3001;
startIndexer().catch(console.error);
startHistoricalYieldAggregationJob();
startSharePriceSnapshotJob();
startHealthMonitor().catch(console.error);

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
