#!/usr/bin/env python3
"""Normalize SCIM recipes to items/min and m3/min"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import re
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
SOURCE = "https://static.satisfactory-calculator.com/data/json/gameData/en-Stable.json"
LOCALIZED_SOURCE = "https://static.satisfactory-calculator.com/data/json/gameData/ru-Stable.json"
HEADERS = {"User-Agent": "FactoryLens/1.0 (community production planner)"}
EXTRACTION_BUILDINGS = {
    "Build_MinerMk1_C", "Build_MinerMk2_C", "Build_MinerMk3_C", "Build_OilPump_C",
    "Build_WaterPump_C", "Build_FrackingSmasher_C", "Build_FrackingExtractor_C",
}
NUCLEAR_BUILDING = "Build_GeneratorNuclear_C"
NUCLEAR_RECIPES = {"Recipe_UraniumWaste_C", "Recipe_PlutoniumWaste_C"}
WASTE_EXTERNAL_INPUTS = {"Desc_NuclearWaste_C", "Desc_PlutoniumWaste_C"}


def read_source(value: str) -> bytes:
    if value.startswith(("https://", "http://")):
        request = urllib.request.Request(value, headers=HEADERS)
        with urllib.request.urlopen(request, timeout=90) as response:
            return response.read()
    return Path(value).read_bytes()


def class_id(path: str) -> str:
    return path.rsplit(".", 1)[-1]


def strip_markup(value: str) -> str:
    return re.sub(r"<[^>]*>", " ", value).strip()


def localized_name(ru: dict, section: str, key: str, fallback: str) -> str:
    return ru.get(section, {}).get(key, {}).get("name", fallback).replace("—", "-").replace("–", "-")


def normalize(raw: dict, ru: dict, fingerprint: str, game_version: str) -> dict:
    item_records = raw["itemsData"] | raw["toolsData"]
    ru_items = ru.get("itemsData", {}) | ru.get("toolsData", {})
    raw_buildings = raw["buildingsData"]
    factory_buildings = {
        key: val for key, val in raw_buildings.items()
        if val.get("category") == "production"
    }
    generator_buildings = {NUCLEAR_BUILDING: raw_buildings[NUCLEAR_BUILDING]}
    recipe_buildings = factory_buildings | generator_buildings
    all_machine_buildings = factory_buildings | {
        key: raw_buildings[key] for key in EXTRACTION_BUILDINGS if key in raw_buildings
    } | generator_buildings
    mined_ids = {key for key, val in item_records.items() if val.get("category") == "ore"}
    raw_ids = mined_ids | {"Desc_Water_C", "Desc_LiquidOil_C", "Desc_NitrogenGas_C"}

    # Some recipes named Alternate are now unlocked through MAM
    schematics = raw.get("schematicsData", {})
    research_unlocked = set()
    seen_schematics = set()

    def visit_schematic(schematic_id: str) -> None:
        if schematic_id in seen_schematics:
            return
        seen_schematics.add(schematic_id)
        schematic = schematics.get(schematic_id, {})
        research_unlocked.update(class_id(value) for value in schematic.get("recipes", []))
        for child in schematic.get("schematics", []):
            visit_schematic(class_id(child))

    for schematic_id in schematics:
        if schematic_id.startswith("Research_"):
            visit_schematic(schematic_id)

    def item_form(item_id: str) -> str:
        category = item_records[item_id].get("category")
        return category if category in ("liquid", "gas") else "solid"

    def rates(amounts: dict | list, seconds: float) -> dict:
        result = {}
        for path, amount in (amounts or {}).items():
            item_id = class_id(path)
            if item_id not in item_records:
                raise ValueError(f"Recipe refers to missing item: {item_id}")
            unit_scale = 1000 if item_form(item_id) in ("liquid", "gas") else 1
            result[item_id] = float(amount) * 60 / seconds / unit_scale
        return result

    recipes = []
    used_items = set(raw_ids)
    for recipe_id, recipe in raw["recipesData"].items():
        producers = [class_id(value) for value in recipe.get("mProducedIn", [])]
        producers = [value for value in producers if value in factory_buildings or
                     (value == NUCLEAR_BUILDING and recipe_id in NUCLEAR_RECIPES)]
        if not producers:
            continue
        if len(producers) != 1:
            raise ValueError(f"Ambiguous factory building for {recipe_id}: {producers}")
        building_id = producers[0]
        building = recipe_buildings[building_id]
        generator = building_id in generator_buildings
        seconds = float(recipe["mManufactoringDuration"])
        if seconds <= 0:
            raise ValueError(f"Non-positive craft duration: {recipe_id}")
        inputs = rates(recipe.get("ingredients", {}), seconds)
        outputs = rates(recipe.get("produce", {}), seconds)
        if generator:
            supplemental_item = building["supplementalLoadType"]
            if item_form(supplemental_item) not in ("liquid", "gas"):
                raise ValueError(f"Unexpected nuclear supplemental resource: {supplemental_item}")
            inputs[supplemental_item] = (
                float(building["supplementalLoadRatio"]) * float(building["powerGenerated"]) * 60 / 1000
            )
        if not outputs or any(value <= 0 for value in outputs.values()):
            raise ValueError(f"Invalid recipe products: {recipe_id}")
        used_items.update(inputs)
        used_items.update(outputs)
        power_pair = building.get("powerUsedRecipes", {}).get(recipe_id)
        if not generator and power_pair is None and "powerUsed" not in building:
            raise ValueError(f"Missing recipe power data: {recipe_id}")
        minimum, maximum = ((0.0, 0.0) if generator else map(float, power_pair) if power_pair is not None
                            else (float(building["powerUsed"]), float(building["powerUsed"])))
        if maximum < minimum:
            raise ValueError(f"Invalid power range: {recipe_id}")
        seasonal = any(item_records[key].get("category") == "ficsmas" for key in inputs | outputs)
        conversion = building_id == "Build_Converter_C" and any(key in raw_ids for key in outputs)
        name = recipe["name"]
        alternate = name.startswith("Alternate:") and recipe_id not in research_unlocked
        normalized = {
            "id": recipe_id, "name": name,
            "nameRu": localized_name(ru, "recipesData", recipe_id, name),
            "alternate": alternate, "buildingId": building_id, "time": seconds,
            "unlockType": "hardDrive" if alternate else "research" if recipe_id in research_unlocked else "standard",
            "inputs": inputs, "outputs": outputs,
            "powerMW": (minimum + maximum) / 2,
            "powerMinMW": minimum, "powerMaxMW": maximum,
            "seasonal": seasonal, "conversion": conversion,
            "defaultEnabled": not seasonal,
        }
        if generator:
            normalized.update({"generator": True, "generationMW": float(building["powerGenerated"])})
        recipes.append(normalized)

    produced = {key for recipe in recipes for key in recipe["outputs"]}
    consumed = {key for recipe in recipes for key in recipe["inputs"]}
    external_ids = (consumed - produced - raw_ids) | WASTE_EXTERNAL_INPUTS
    items = []
    for item_id in sorted(used_items):
        item = item_records[item_id]
        form = item_form(item_id)
        record = {
            "id": item_id, "name": item["name"],
            "nameRu": ru_items.get(item_id, {}).get("name", item["name"]).replace("—", "-").replace("–", "-"),
            "form": form, "raw": item_id in raw_ids,
            "external": item_id in external_ids,
            "sinkable": form == "solid" and item.get("resourceSinkPoints", 0) > 0,
            "sinkPoints": item.get("resourceSinkPoints", 0),
            "category": item.get("category", "standard"),
            "color": item.get("color"),
            "icon": f"icons/{item_id}.png",
            "iconSourceUrl": item.get("image"),
        }
        items.append(record)

    buildings = []
    for building_id, building in all_machine_buildings.items():
        record = {
            "id": building_id, "name": building["name"],
            "nameRu": localized_name(ru, "buildingsData", building_id, building["name"]),
            "powerMW": float(building.get("powerUsed", 0)),
            "powerExponent": 1.321929,
            "variablePower": bool(building.get("powerUsedRecipes")),
            "icon": f"icons/{building_id}.png", "iconSourceUrl": building.get("image"),
            "width": building.get("width"), "length": building.get("length"),
        }
        if building_id in generator_buildings:
            record.update({"generator": True, "generationMW": float(building["powerGenerated"]), "powerExponent": 1})
        buildings.append(record)

    resources = []
    for item_id in sorted(mined_ids):
        resources.append({
            "itemId": item_id, "weight": 1, "baseRate": 60, "powerMW": 5,
            "type": "miner", "defaultLimit": None,
            "buildingId": "Build_MinerMk1_C",
        })
    resources += [
        {"itemId": "Desc_LiquidOil_C", "weight": 1, "baseRate": 120, "powerMW": 40,
         "type": "oil", "defaultLimit": None, "buildingId": "Build_OilPump_C"},
        {"itemId": "Desc_Water_C", "weight": 0, "baseRate": 120, "powerMW": 20,
         "type": "water", "defaultLimit": None, "buildingId": "Build_WaterPump_C"},
        {"itemId": "Desc_NitrogenGas_C", "weight": 1, "baseRate": 60, "powerMW": 0,
         "type": "well", "defaultLimit": None, "buildingId": "Build_FrackingExtractor_C",
         "note": "Экстрактор скважины: 60 м³/мин на обычном узле. Общий прессуризатор 150 МВт считается отдельно; его стоимость зависит от числа спутников."},
    ]
    for item_id in sorted(external_ids):
        resources.append({
            "itemId": item_id, "weight": 1, "baseRate": 1, "powerMW": 0,
            "type": "external", "defaultLimit": 0,
            "note": "Внешний вход: ручной сбор, сезонный источник или отходы генератора. Автоматическая бесконечная добыча не предполагается.",
        })
    result = {
        "meta": {
            "gameVersion": game_version,
            "sourceUrl": SOURCE, "localizationSourceUrl": LOCALIZED_SOURCE,
            "sourceSha256": fingerprint,
            "fetchedAt": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
            "coverage": f"{sum(not r.get('generator') for r in recipes)} manufacturing recipes, {sum(r.get('generator', False) for r in recipes)} nuclear fuel processes, {sum(r['alternate'] for r in recipes)} marked alternate, {len(factory_buildings)} production building types",
            "counts": {"items": len(items), "recipes": len(recipes),
                       "manufacturingRecipes": sum(not r.get("generator") for r in recipes),
                       "generatorProcesses": sum(r.get("generator", False) for r in recipes),
                       "alternates": sum(r["alternate"] for r in recipes),
                       "seasonalRecipes": sum(r["seasonal"] for r in recipes),
                       "productionBuildings": len(factory_buildings),
                       "generatorBuildings": len(generator_buildings),
                       "externalInputs": len(external_ids)},
            "minerPowerMW": {"1": 5, "2": 15, "3": 45},
            "minerNormalRate": {"1": 60, "2": 120, "3": 240},
            "clockPowerExponent": 1.3219280948873624,
            "notes": [
                "SCIM Stable snapshot; the feed identifies a branch without an exact game build",
                "Includes recipes for 11 production building types, Tier 9 and FICSMAS; excludes construction, vehicles and manual-only crafting",
                "Charcoal, Biocoal, Compacted Coal and Polyester Fabric are MAM research recipes despite their legacy Alternate names",
                "Rates use items/min and m3/min at 100% clock",
                "Variable power uses the midpoint of the source range, with both endpoints retained",
                "Seasonal recipes are disabled by default; limited hand-collected inputs require an explicit external supply",
                "Uranium and plutonium fuel burning include fuel, cooling water and waste; generated power is reported separately from consumption",
                "Other power generation, Ficsonium fuel burning and power-grid balancing are outside this production model",
                "Nuclear waste retains optional external inputs with a default limit of zero for existing-plant supplies and saved-plan compatibility",
                "Resource well pressurizer power must be added for the actual well layout",
                "The planner offers map scarcity, equal and custom resource weights",
            ],
        },
        "items": items, "buildings": buildings, "recipes": recipes, "resources": resources,
    }
    validate(result)
    return result


def validate(data: dict) -> None:
    items = {item["id"]: item for item in data["items"]}
    buildings = {building["id"] for building in data["buildings"]}
    recipes = data["recipes"]
    assert len(items) == len(data["items"]), "Duplicate item ids"
    assert len({recipe["id"] for recipe in recipes}) == len(recipes), "Duplicate recipe ids"
    assert len(recipes) > 250, "Unexpectedly incomplete recipe feed"
    assert sum(recipe["alternate"] for recipe in recipes) >= 100, "Missing alternate recipes"
    for recipe in recipes:
        assert recipe["buildingId"] in buildings
        assert set(recipe["inputs"]) | set(recipe["outputs"]) <= set(items)
        assert recipe["time"] > 0 and recipe["powerMW"] >= 0
    by_id = {recipe["id"]: recipe for recipe in recipes}
    assert by_id["Recipe_Alternate_PureIronIngot_C"]["inputs"]["Desc_Water_C"] == 20
    assert by_id["Recipe_Alternate_PureIronIngot_C"]["outputs"]["Desc_IronIngot_C"] == 65
    assert by_id["Recipe_AluminaSolution_C"]["outputs"]["Desc_AluminaSolution_C"] == 120
    assert by_id["Recipe_QuantumEnergy_C"]["outputs"]["Desc_QuantumEnergy_C"] == 200
    for key in NUCLEAR_RECIPES:
        recipe = by_id[key]
        assert recipe["generator"] and recipe["generationMW"] == 2500
        assert recipe["powerMW"] == 0 and recipe["inputs"]["Desc_Water_C"] == 240
    assert by_id["Recipe_UraniumWaste_C"]["inputs"]["Desc_NuclearFuelRod_C"] == 0.2
    assert by_id["Recipe_UraniumWaste_C"]["outputs"]["Desc_NuclearWaste_C"] == 10
    assert by_id["Recipe_PlutoniumWaste_C"]["inputs"]["Desc_PlutoniumFuelRod_C"] == 0.1
    assert by_id["Recipe_PlutoniumWaste_C"]["outputs"]["Desc_PlutoniumWaste_C"] == 1


def verify_docs(data: dict, docs_path: str, version: str | None) -> dict:
    """Independently compare every manufacturing recipe with a game Docs dump."""
    payload = read_source(docs_path)
    encoding = "utf-16" if payload[:2] in (b"\xff\xfe", b"\xfe\xff") else "utf-8-sig"
    doc_groups = json.loads(payload.decode(encoding))
    docs = {entry["ClassName"]: entry for group in doc_groups for entry in group["Classes"]}
    native = {entry["ClassName"]: group["NativeClass"] for group in doc_groups for entry in group["Classes"]}
    normalized = {recipe["id"]: recipe for recipe in data["recipes"] if not recipe.get("generator")}
    buildings = {recipe["buildingId"] for recipe in normalized.values()}
    items = {item["id"]: item for item in data["items"]}
    doc_recipes = {
        key: entry for key, entry in docs.items()
        if "FGRecipe" in native[key]
        and any(building in entry.get("mProducedIn", "") for building in buildings)
    }
    if set(normalized) != set(doc_recipes):
        raise ValueError(f"Recipe coverage mismatch: only feed={set(normalized)-set(doc_recipes)}; only Docs={set(doc_recipes)-set(normalized)}")
    for key, recipe in normalized.items():
        source = doc_recipes[key]
        seconds = float(source["mManufactoringDuration"])
        if not math.isclose(seconds, recipe["time"], abs_tol=1e-8):
            raise ValueError(f"Recipe duration mismatch: {key}")
        for output_key, doc_key in (("inputs", "mIngredients"), ("outputs", "mProduct")):
            pairs = re.findall(r"\.([^\.\'/]+)'\",Amount=([\d.]+)", source[doc_key])
            rates = {item: float(amount)*60/seconds/(1000 if items[item]["form"] != "solid" else 1) for item, amount in pairs}
            if set(rates) != set(recipe[output_key]) or any(not math.isclose(value, recipe[output_key][item], abs_tol=1e-8) for item, value in rates.items()):
                raise ValueError(f"Recipe quantities mismatch: {key}, {output_key}")
        building = docs[recipe["buildingId"]]
        if "ManufacturerVariablePower" in native[recipe["buildingId"]]:
            minimum = float(source["mVariablePowerConsumptionConstant"])
            maximum = minimum + float(source["mVariablePowerConsumptionFactor"])
        else:
            minimum = maximum = float(building["mPowerConsumption"])
        if not math.isclose(minimum, recipe["powerMinMW"], abs_tol=1e-8) or not math.isclose(maximum, recipe["powerMaxMW"], abs_tol=1e-8):
            raise ValueError(f"Recipe power mismatch: {key}")
    generators = [recipe for recipe in data["recipes"] if recipe.get("generator")]
    for recipe in generators:
        building = docs[recipe["buildingId"]]
        generation = float(building["mPowerProduction"])
        fuel = next((entry for entry in building["mFuel"] if entry.get("mByproduct") in recipe["outputs"]), None)
        if not fuel:
            raise ValueError(f"Generator waste not found in Docs: {recipe['id']}")
        energy = float(docs[fuel["mFuelClass"]]["mEnergyValue"])
        fuel_rate = generation * 60 / energy
        inputs = {fuel["mFuelClass"]: fuel_rate,
                  fuel["mSupplementalResourceClass"]: float(building["mSupplementalToPowerRatio"]) * generation * 60 / 1000}
        outputs = {fuel["mByproduct"]: fuel_rate * float(fuel["mByproductAmount"])}
        for field, expected in (("inputs", inputs), ("outputs", outputs)):
            if set(recipe[field]) != set(expected) or any(not math.isclose(value, recipe[field][item], abs_tol=1e-8) for item, value in expected.items()):
                raise ValueError(f"Generator quantity mismatch: {recipe['id']}, {field}")
        if not math.isclose(recipe["generationMW"], generation, abs_tol=1e-8) or recipe["powerMW"] != 0:
            raise ValueError(f"Generator power mismatch: {recipe['id']}")
        if not math.isclose(recipe["time"], energy / generation, abs_tol=1e-8):
            raise ValueError(f"Generator burn duration mismatch: {recipe['id']}")
    return {"version": version, "sha256": hashlib.sha256(payload).hexdigest(),
            "recipeCount": len(doc_recipes), "matched": ["coverage", "inputs", "outputs", "time", "powerMinMW", "powerMaxMW"],
            "generatorProcesses": len(generators), "generatorMatched": ["fuel", "water", "waste", "time", "generationMW"]}


def download_icons(data: dict, output_dir: Path) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    entries = [(entry, output_dir / f"{entry['id']}.png")
               for entry in data["items"] + data["buildings"] if entry.get("iconSourceUrl")]

    def fetch_one(pair):
        entry, target = pair
        if target.is_file() and target.stat().st_size > 100:
            return None
        try:
            payload = read_source(entry["iconSourceUrl"])
            if not payload.startswith(b"\x89PNG\r\n\x1a\n"):
                raise ValueError("Source is not a PNG")
            target.write_bytes(payload)
            return None
        except Exception as exc:
            entry["icon"] = None
            return f"{entry['id']}: {exc}"

    failures = []
    with ThreadPoolExecutor(max_workers=10) as pool:
        for future in as_completed([pool.submit(fetch_one, pair) for pair in entries]):
            error = future.result()
            if error:
                failures.append(error)
    if failures:
        print(f"Icon download failed for {len(failures)} entries:")
        for error in failures:
            print("  " + error)
    print(f"Icons available: {len(entries) - len(failures)}/{len(entries)}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", default=SOURCE)
    parser.add_argument("--locale-source", default=LOCALIZED_SOURCE)
    parser.add_argument("--game-version", default="1.2 / SCIM Stable")
    parser.add_argument("--download-icons", action="store_true")
    parser.add_argument("--verify-docs", help="Optional original CommunityResources/Docs/en-US.json for complete independent validation")
    parser.add_argument("--verify-version", help="Version label of the supplied game Docs file (never inferred from filename)")
    parser.add_argument("--output", type=Path, default=ROOT / "dist/data/game-data.json")
    args = parser.parse_args()
    english_bytes = read_source(args.source)
    russian_bytes = read_source(args.locale_source)
    data = normalize(json.loads(english_bytes), json.loads(russian_bytes),
                     hashlib.sha256(english_bytes).hexdigest(), args.game_version)
    if args.output.is_file():
        previous = json.loads(args.output.read_text(encoding="utf-8"))
        if previous.get("meta", {}).get("sourceSha256") == data["meta"]["sourceSha256"] and previous.get("recipes") == data["recipes"]:
            for key in ("docsVerification", "recipeAudit", "nuclearVerification"):
                if key in previous["meta"]:
                    data["meta"][key] = previous["meta"][key]
    if args.verify_docs:
        data["meta"]["docsVerification"] = verify_docs(data, args.verify_docs, args.verify_version)
    if args.download_icons:
        download_icons(data, ROOT / "dist/icons")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(json.dumps(data["meta"]["counts"], ensure_ascii=False))
    print(f"Wrote {args.output}")


if __name__ == "__main__":
    main()
