from pathlib import Path

HERE = Path(__file__).resolve().parent
src = HERE / "server_get_state_reads_candidate_20261014.js"
target = HERE / "server_get_critical_path_candidate_20261014.js"
code = src.read_text(encoding="utf-8")

def one(old, new, label):
    global code
    count = code.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly one match, got {count}")
    code = code.replace(old, new, 1)

one(
'''async function murabbikMilkMirrorSmartAlertSourceSrv(context) {
 const [animals, sharedEvents] = await Promise.all([
  murabbikSmartAlertAnimalsSrv(context),
  murabbikSmartAlertEventsIndexSrv(context)
 ]);

const allEvents = sharedEvents.rows;
    const officialGroupsResult =
    await context.load(
      "smart-alerts:milk-mirror-official-groups",

      async () =>
        await milkReportLoadOfficialGroupsMapFromFirestoreSrv(
          context.userId,
          animals,
          true
        )
    );''',
'''async function murabbikMilkMirrorSmartAlertSourceSrv(context) {
 // GET: official groups depend on animals, but not on the large events read.
 // Keep POST and standalone source callers on the original ordering.
 const animalsPromise = murabbikSmartAlertAnimalsSrv(context);
 const eventsPromise = murabbikSmartAlertEventsIndexSrv(context);
 const loadOfficialGroups = animals => context.load(
   "smart-alerts:milk-mirror-official-groups",
   async () => await milkReportLoadOfficialGroupsMapFromFirestoreSrv(
     context.userId,
     animals,
     true
   )
 );
 const earlyGroupsPromise = context.getOnlyIndependentReads === true
   ? animalsPromise.then(loadOfficialGroups)
   : null;

 // Include the early promise in Promise.all so failures are fully observed.
 const [animals, sharedEvents] = await Promise.all(
   earlyGroupsPromise
     ? [animalsPromise, eventsPromise, earlyGroupsPromise]
     : [animalsPromise, eventsPromise]
 );

const allEvents = sharedEvents.rows;
 const officialGroupsResult = earlyGroupsPromise
   ? await earlyGroupsPromise
   : await loadOfficialGroups(animals);''',
"milk_mirror_independent_groups"
)
one(
'''  const weather =
    await context.load(
      "daily-greeting:weather-thi",
      async () =>
        await weatherBuildFarmThiSrv(
          profileUid
        )
    );

  const herd =
    await context.load(
      "daily-greeting:herd-species",
      async () =>
        await murabbikGreetingHerdSpeciesSrv(
          context
        )
    );''',
'''  // GET: independent weather and herd reads can overlap.
  // Other callers retain the original serial ordering.
  const loadWeather = () => context.load(
    "daily-greeting:weather-thi",
    async () => await weatherBuildFarmThiSrv(profileUid)
  );
  const loadHerd = () => context.load(
    "daily-greeting:herd-species",
    async () => await murabbikGreetingHerdSpeciesSrv(context)
  );
  const [weather, herd] = context.getOnlyIndependentReads === true
    ? await Promise.all([loadWeather(), loadHerd()])
    : [await loadWeather(), await loadHerd()];''',
"greeting_independent_reads"
)
one(
'''    shareLargeEventsSnapshot: true,
    memo: new Map()''',
'''    shareLargeEventsSnapshot: true,
    getOnlyIndependentReads: true,
    memo: new Map()''',
"GET_only_flag"
)
target.write_text(code, encoding="utf-8")
print(f"BUILT {target.name} bytes={target.stat().st_size}")
