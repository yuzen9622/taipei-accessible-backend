import mongoose from "mongoose";
import { tdxFetch } from "../config/fetch";

async function main() {
  const routeId = "70";
  const city = "Taichung";
  const url = `https://tdx.transportdata.tw/api/basic/v2/Bus/Schedule/City/${city}/${routeId}?$format=JSON`;

  console.log(`Fetching from TDX: ${url}`);
  const resp = await tdxFetch(url);
  if (!resp.ok) {
    console.error("TDX Error:", resp.status);
    return;
  }

  const records = (await resp.json()) as any[];
  console.log(`Total records: ${records.length}`);

  // Let's inspect the first record's Timetables
  if (records.length > 0) {
    const firstRecord = records[0];
    console.log("SubRouteUID:", firstRecord.SubRouteUID);
    console.log("Direction:", firstRecord.Direction);
    console.log("Timetables count:", firstRecord.Timetables?.length);
    if (firstRecord.Timetables && firstRecord.Timetables.length > 0) {
      const firstTimetable = firstRecord.Timetables[0];
      console.log("First Timetable ServiceDay:", firstTimetable.ServiceDay);
      console.log("StopTimes count:", firstTimetable.StopTimes?.length);
      if (firstTimetable.StopTimes && firstTimetable.StopTimes.length > 0) {
        console.log("Sample StopTimes (first 5):");
        for (let i = 0; i < Math.min(5, firstTimetable.StopTimes.length); i++) {
          const st = firstTimetable.StopTimes[i];
          console.log(`  Seq: ${st.StopSequence} | StopName: ${st.StopName?.Zh_tw} | ArrivalTime: ${st.ArrivalTime} | DepartureTime: ${st.DepartureTime}`);
        }
      }
    }
  }
}

main().catch(err => {
  console.error(err);
});
