#!/usr/bin/env python3
"""Convert the spreadsheet-era itinerary into the website's event schema."""

from __future__ import annotations

import hashlib
import json
import re
import sys
from collections import defaultdict
from datetime import date, datetime, time, timedelta
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from trip_schema import migrate_v4_to_v5  # noqa: E402

SOURCE_ROOT = Path('/mnt/data/webapp_project')
SOURCE_PROJECT = SOURCE_ROOT / 'itinerary_project.json'
SOURCE_ROUTE = SOURCE_ROOT / 'route_manifest.json'
OUTPUT = ROOT / 'data' / 'itinerary.json'

CATEGORY_COLOURS = {
    'Sleep': '#294C60',
    'Meal': '#F4D6A0',
    'Activity': '#7FB77E',
    'Hike': '#4FA3A5',
    'Travel': '#E58C47',
    'Rest': '#C9CED6',
    'Admin': '#E8C547',
    'Evening': '#A98CC2',
    'Tour': '#5D9CEC',
}

CONFIDENCE_RANK = {'Low': 0, 'Medium': 1, 'High': 2}

TIMEZONES = {
    'home': 'Europe/London',
    'buenos_aires': 'America/Argentina/Buenos_Aires',
    'ushuaia': 'America/Argentina/Ushuaia',
    'el_calafate': 'America/Argentina/Rio_Gallegos',
    'el_chalten': 'America/Argentina/Rio_Gallegos',
    'puerto_natales': 'America/Punta_Arenas',
    'tdp_central': 'America/Punta_Arenas',
    'tdp_cuernos': 'America/Punta_Arenas',
    'tdp_paine_grande': 'America/Punta_Arenas',
    'tdp_grey': 'America/Punta_Arenas',
    'santiago': 'America/Santiago',
    'bogota': 'America/Bogota',
    'salento': 'America/Bogota',
    'medellin': 'America/Bogota',
    'cartagena': 'America/Bogota',
    'minca': 'America/Bogota',
    'tayrona': 'America/Bogota',
    'santa_marta': 'America/Bogota',
    'san_jose': 'America/Costa_Rica',
    'la_fortuna': 'America/Costa_Rica',
    'monteverde': 'America/Costa_Rica',
    'drake_bay': 'America/Costa_Rica',
    'ometepe': 'America/Managua',
    'granada': 'America/Managua',
    'leon': 'America/Managua',
    'las_penitas': 'America/Managua',
    'antigua': 'America/Guatemala',
    'acatenango': 'America/Guatemala',
    'lake_atitlan': 'America/Guatemala',
    'flores': 'America/Guatemala',
    'caye_caulker': 'America/Belize',
    'bacalar': 'America/Cancun',
    'valladolid': 'America/Merida',
    'merida': 'America/Merida',
    'mexico_city': 'America/Mexico_City',
    'puebla': 'America/Mexico_City',
    'oaxaca': 'America/Mexico_City',
    'lima': 'America/Lima',
    'huaraz': 'America/Lima',
    'arequipa': 'America/Lima',
    'colca': 'America/Lima',
    'cusco': 'America/Lima',
    'ollantaytambo': 'America/Lima',
    'salkantay': 'America/Lima',
    'aguas_calientes': 'America/Lima',
    'copacabana': 'America/La_Paz',
    'la_paz': 'America/La_Paz',
    'sucre': 'America/La_Paz',
    'potosi': 'America/La_Paz',
    'uyuni': 'America/La_Paz',
    'uyuni_salt': 'America/La_Paz',
    'uyuni_altiplano': 'America/La_Paz',
    'san_pedro': 'America/Santiago',
}


def local_datetime(day_value: str, hour_value: int) -> datetime:
    day = date.fromisoformat(day_value)
    if hour_value == 24:
        return datetime.combine(day + timedelta(days=1), time.min)
    return datetime.combine(day, time(hour_value, 0))


def iso_minutes(value: datetime) -> str:
    return value.isoformat(timespec='minutes')


def unique_join(values: list[str]) -> str:
    seen = []
    for value in values:
        value = (value or '').strip()
        if value and value not in seen:
            seen.append(value)
    return '\n\n'.join(seen)


def infer_mode(text: str, default: str = 'Local transfer') -> str:
    lower = text.lower()
    if any(token in lower for token in ('flight', 'fly ', 'airport', 'long-haul')):
        return 'Flight'
    if any(token in lower for token in ('ferry', 'boat', 'catamaran', 'water taxi', 'cruise')):
        return 'Ferry / boat'
    if 'train' in lower:
        return 'Train'
    if any(token in lower for token in ('trek', 'hike', 'trail', 'walk')):
        return 'Trek / walk'
    if any(token in lower for token in ('bus', 'road', 'border', 'shuttle', 'transfer', 'drive', 'terminal')):
        return 'Road / bus'
    return default or 'Local transfer'


def event_id(index: int, title: str, start: str) -> str:
    digest = hashlib.sha1(f'{index}|{title}|{start}'.encode('utf-8')).hexdigest()[:8]
    return f'evt_{index:04d}_{digest}'


def main() -> None:
    source = json.loads(SOURCE_PROJECT.read_text(encoding='utf-8'))
    route = json.loads(SOURCE_ROUTE.read_text(encoding='utf-8'))
    stops = [stop for stop in route['stops'] if stop['sequence'] > 0]
    stop_by_visit = {stop['visit_id']: stop for stop in stops}
    visit_order = [stop['visit_id'] for stop in stops]
    previous_location: dict[str, str] = {}
    for index, visit_id in enumerate(visit_order):
        previous_location[visit_id] = (
            source['meta']['home_location_id']
            if index == 0
            else stop_by_visit[visit_order[index - 1]]['location_id']
        )

    locations = {}
    for location_id, location in source['locations'].items():
        locations[location_id] = {
            'id': location_id,
            'name': location['name'],
            'country': location['country'],
            'latitude': location['lat'],
            'longitude': location['lon'],
            'timezone': TIMEZONES.get(location_id, ''),
            'notes': '',
        }

    visits = []
    for stop in stops:
        visits.append({
            'id': stop['visit_id'],
            'order': stop['sequence'],
            'location_id': stop['location_id'],
            'start_date': stop['block_start'],
            'end_date': stop['block_end'],
            'stay_start_date': stop['stay_start'],
            'stay_end_date': stop['stay_end'],
            'arrival_mode': stop['arrival_mode'] or 'Local transfer',
            'arrival_hours_estimate': stop['arrival_hours'],
            'arrival_summary': stop['arrival_summary'],
            'notes': stop.get('notes', ''),
        })

    days = []
    for day_row in source['days']:
        days.append({
            'date': day_row['date'],
            'day_number': day_row['day'],
            'visit_id': day_row['visit_id'],
            'location_id': day_row['location_id'],
            'country': day_row['country'],
            'base': day_row['base'],
            'summary': day_row['summary'],
            'notes': day_row['notes'],
            'confidence': day_row['confidence'],
            'is_physical_location_day': bool(day_row.get('is_physical_location_day')),
        })

    raw_events: list[dict[str, Any]] = []
    for day_row in source['days']:
        stop = stop_by_visit[day_row['visit_id']]
        for segment_index, segment in enumerate(day_row['segments']):
            start_hour, end_hour, category, title = segment
            start_dt = local_datetime(day_row['date'], start_hour)
            end_dt = local_datetime(day_row['date'], end_hour)
            text = f"{title} {day_row['summary']}"
            mode = infer_mode(text, stop.get('arrival_mode', 'Local transfer')) if category in {'Travel', 'Hike'} else ''
            from_location_id = ''
            to_location_id = ''
            if category in {'Travel', 'Hike'}:
                on_first_visit_day = day_row['date'] == stop['block_start']
                if on_first_visit_day:
                    from_location_id = previous_location[day_row['visit_id']]
                    to_location_id = day_row['location_id']
                else:
                    from_location_id = day_row['location_id']
                    to_location_id = day_row['location_id']

            raw_events.append({
                'title': title,
                'category': category,
                'start': iso_minutes(start_dt),
                'end': iso_minutes(end_dt),
                'visit_id': day_row['visit_id'],
                'location_id': day_row['location_id'],
                'from_location_id': from_location_id,
                'to_location_id': to_location_id,
                'transport_mode': mode,
                'confidence': day_row['confidence'],
                'notes_parts': [day_row['notes']],
                'day_summaries': [day_row['summary']],
                'source_dates': [day_row['date']],
                'locked': False,
            })

    merged: list[dict[str, Any]] = []
    for current in raw_events:
        if merged:
            previous = merged[-1]
            can_merge = (
                previous['end'] == current['start']
                and previous['title'] == current['title']
                and previous['category'] == current['category']
                and previous['visit_id'] == current['visit_id']
                and previous['location_id'] == current['location_id']
                and previous['transport_mode'] == current['transport_mode']
            )
            if can_merge:
                previous['end'] = current['end']
                previous['notes_parts'].extend(current['notes_parts'])
                previous['day_summaries'].extend(current['day_summaries'])
                previous['source_dates'].extend(current['source_dates'])
                if CONFIDENCE_RANK[current['confidence']] < CONFIDENCE_RANK[previous['confidence']]:
                    previous['confidence'] = current['confidence']
                continue
        merged.append(current)

    events = []
    for index, item in enumerate(merged, start=1):
        start = item['start']
        events.append({
            'id': event_id(index, item['title'], start),
            'title': item['title'],
            'category': item['category'],
            'start': start,
            'end': item['end'],
            'visit_id': item['visit_id'],
            'location_id': item['location_id'],
            'from_location_id': item['from_location_id'],
            'to_location_id': item['to_location_id'],
            'transport_mode': item['transport_mode'],
            'confidence': item['confidence'],
            'notes': unique_join(item['notes_parts']),
            'day_summaries': list(dict.fromkeys(item['day_summaries'])),
            'source_dates': list(dict.fromkeys(item['source_dates'])),
            'locked': item['locked'],
        })

    legacy_output = {
        'schema_version': 4,
        'metadata': {
            'title': source['meta']['title'],
            'description': 'Six-month Americas itinerary with exact-time, multi-day events.',
            'start_date': source['meta']['start_date'],
            'end_date': source['meta']['end_date'],
            'home_location_id': source['meta']['home_location_id'],
            'time_model': 'floating_local',
            'time_model_note': (
                'Event timestamps are local itinerary clock times without UTC offsets. '
                'This keeps each daily bar aligned to the local date and supports exact minutes and multi-day events.'
            ),
            'category_colours': CATEGORY_COLOURS,
            'map_bounds': source['meta']['map_bounds'],
            'created_from': 'Americas_182_Day_Itinerary_With_Map_Jan-Jul_2027.xlsx',
        },
        'locations': locations,
        'visits': visits,
        'days': days,
        'events': events,
        'bookings': source['bookings'],
    }
    output = migrate_v4_to_v5(legacy_output)

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f'Wrote {OUTPUT}')
    print(f"{len(days)} days, {len(events)} events, {len(visits)} visits, {len(locations)} locations")


if __name__ == '__main__':
    main()
