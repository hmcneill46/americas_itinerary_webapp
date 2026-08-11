import { calculateBudget, decimalCompare, formatMoney } from './budget.js';
import { deriveBookingAction } from './booking.js';

const entityLabel = { locations: 'Place', visits: 'Visit', events: 'Event', bookings: 'Booking', cost_items: 'Cost item' };
const idMap = (items, key = 'id') => new Map(Array.isArray(items) ? items.map(item => [item[key], item]) : Object.values(items || {}).map(item => [item[key], item]));
const date = value => String(value || '').slice(0, 10);
const names = (itinerary, entity, item) => entity === 'locations' ? item.name : item.title || item.name || item.id;
const change = (group, kind, label, before = '', after = '', importance = 'normal') => ({ group, kind, label, before, after, importance });

function entityChanges(current, imported, entity) {
  const currentMap = idMap(entity === 'cost_items' ? current.budget.cost_items : current[entity], entity === 'locations' ? 'id' : 'id');
  const nextMap = idMap(entity === 'cost_items' ? imported.budget.cost_items : imported[entity], entity === 'locations' ? 'id' : 'id');
  const group = entity === 'events' || entity === 'visits' ? 'schedule' : entity === 'bookings' ? 'bookings' : entity === 'cost_items' ? 'budget' : 'places'; const out=[];
  for (const [id, next] of nextMap) { if (!currentMap.has(id)) out.push(change(group,'added',`${entityLabel[entity]} added: ${names(imported,entity,next)}`, '', '', entity === 'visits' || entity === 'events' ? 'high' : 'normal')); }
  for (const [id, previous] of currentMap) { if (!nextMap.has(id)) out.push(change(group,'removed',`${entityLabel[entity]} removed: ${names(current,entity,previous)}`, '', '', entity === 'visits' || entity === 'events' ? 'high' : 'normal')); }
  for (const [id, next] of nextMap) { const previous=currentMap.get(id); if (!previous) continue;
    const fields = entity === 'visits' ? [['start_date','start date'],['end_date','end date'],['location_id','location']]
      : entity === 'events' ? [['title','title'],['start','start'],['end','end'],['location_id','location'],['transport_mode','transport'],['outcome','outcome'],['actual_start','actual start'],['actual_end','actual end'],['replaces_event_id','replacement link']]
      : entity === 'bookings' ? [['lifecycle','lifecycle'],['provider','provider'],['cost_item_id','budget link'],['timing.strategy','booking strategy'],['timing.hard_deadline','hard deadline']]
      : entity === 'cost_items' ? [['expected.unit_amount','expected unit amount'],['committed_amount','committed amount'],['fx.rate_to_base','FX rate']]
      : [['name','name'],['latitude','latitude'],['longitude','longitude']];
    const get=(obj,path)=>path.split('.').reduce((v,k)=>v?.[k],obj) ?? '';
    for (const [path,label] of fields) if (String(get(previous,path)) !== String(get(next,path))) out.push(change(group,'modified',`${names(imported,entity,next)}: ${label}`,String(get(previous,path)),String(get(next,path)), path.includes('lifecycle') && next.lifecycle === 'cancelled' ? 'high' : path === 'start_date' || path === 'end_date' || path === 'start' || path === 'end' ? 'high' : 'normal'));
    if (entity === 'cost_items') { const beforePayments=idMap(previous.payments); const afterPayments=idMap(next.payments); for (const [paymentId,payment] of afterPayments) if(!beforePayments.has(paymentId)) out.push(change('budget','added',`${names(imported,entity,next)}: ${payment.kind} added`, '', `${payment.amount} ${next.currency}`, 'normal')); }
  } return out;
}

export function semanticDiff(current, imported, today = new Date().toISOString().slice(0,10)) {
  const changes=[]; if (current.metadata.title !== imported.metadata.title) changes.push(change('overview','modified','Trip title',current.metadata.title,imported.metadata.title,'high'));
  for (const key of ['start_date','end_date']) if (current.metadata[key]!==imported.metadata[key]) changes.push(change('overview','modified',key==='start_date'?'Trip start date':'Trip end date',current.metadata[key],imported.metadata[key],'high'));
  for (const entity of ['locations','visits','events','bookings','cost_items']) changes.push(...entityChanges(current,imported,entity));
  const beforeBudget=calculateBudget(current), afterBudget=calculateBudget(imported), currency=afterBudget.baseCurrency;
  for (const [key,label] of [['expected','Expected cost'],['committed','Committed'],['paid','Paid'],['headroom','Budget headroom']]) { const a=beforeBudget.totals[key], b=afterBudget.totals[key]; if(a!==null&&b!==null&&decimalCompare(a,b)!==0) changes.push(change('budget','modified',label,formatMoney(a,currency),formatMoney(b,currency),'normal')); }
  for (const booking of imported.bookings) { const old=current.bookings.find(item=>item.id===booking.id); if(!old) continue; const oldAction=deriveBookingAction(old,current,today), newAction=deriveBookingAction(booking,imported,today); if(oldAction.recommendedDate!==newAction.recommendedDate) changes.push(change('bookings','modified',`${booking.title}: recommended booking date`,oldAction.recommendedDate||'not set',newAction.recommendedDate||'not set','normal')); }
  const grouped=changes.reduce((all,item)=>{ (all[item.group] ||= []).push(item); return all; }, {}); const sharedVisits=current.visits.filter(v=>imported.visits.some(n=>n.id===v.id)).length; const replacement=current.visits.length>0 && sharedVisits/current.visits.length<.3;
  return { changes, grouped, total:changes.length, replacement, beforeBudget, afterBudget };
}
