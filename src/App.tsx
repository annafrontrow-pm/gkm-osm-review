import { useEffect, useMemo, useRef, useState } from 'react';
import OLMap from 'ol/Map';
import View from 'ol/View';
import TileLayer from 'ol/layer/Tile';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import OSM from 'ol/source/OSM';
import XYZ from 'ol/source/XYZ';
import GeoJSON from 'ol/format/GeoJSON';
import { Circle as CircleStyle, Fill, Stroke, Style, Text } from 'ol/style';
import Overlay from 'ol/Overlay';
import { createEmpty, extend, isEmpty } from 'ol/extent';
import { defaults as defaultControls } from 'ol/control/defaults';
type FeatureCollection = { type: 'FeatureCollection'; features: Array<{ properties?: Record<string, unknown> | null; [key: string]: unknown }> };

type Case = { quality_category?: string; case_id: string; grid_cell: string; severity_band: string; start_gid: string; end_gid: string; related_directed_links: number; otp_60_length_ratio: number|null; details?: Record<string,string|number|null>; contains_add?: boolean|null; municipalities?: Array<{number:string;name:string}> };
type Cluster = { cluster_id:string; directed_cases:number; add_cases:number; no_add_cases:number; max_saved_m:number; case_ids:string[] }; 
type Review = { decision: string; reason: string; comment: string; reviewer: string };
type Data = { cases: Case[]; gkm: FeatureCollection; otp: FeatureCollection; add?: FeatureCollection; stop_points?: FeatureCollection; category_counts?: Record<string,number> };
const categoryOptions = [{value:'ALL',label:'Alla gånglänkar'},{value:'SIMILAR',label:'Likvärdig längd (±10 %)'},{value:'SLIGHTLY_SHORT',label:'OTP 10–25 % kortare'},{value:'MODERATELY_SHORT',label:'OTP 25–50 % kortare'},{value:'VERY_SHORT',label:'OTP över 50 % kortare'},{value:'LONGER',label:'OTP över 10 % längre'},{value:'NO_ROUTE',label:'Ingen OTP-rutt'},{value:'NOT_ELIGIBLE',label:'Saknar aktuella hållplatslägen'},{value:'OTHER',label:'Övriga/ej jämförbara'}];
const qualityOptions = [
  {value:'ALL',label:'Alla kvalitetskategorier'},
  {value:'HIGH_GEOMETRY_AGREEMENT',label:'Hög geometrisk överensstämmelse'},
  {value:'PARTIAL_GEOMETRY_AGREEMENT',label:'Partiell geometrisk överensstämmelse'},
  {value:'LOW_GEOMETRY_AGREEMENT',label:'Låg geometrisk överensstämmelse'},
  {value:'TIME_ONLY_NO_GKM_GEOMETRY',label:'Endast GKM-tid, ingen geometri'},
  {value:'NO_CURRENT_ENDPOINTS',label:'Saknar aktuella hållplatslägen'},
  {value:'NO_OSM_ROUTE',label:'Ingen OTP-rutt'},
  {value:'GEOMETRY_NOT_COMPARABLE',label:'Geometri ej jämförbar'}
];
const decisions = [{value:'OTP_ACCEPTABLE',label:'OTP-vägen är acceptabel'}, {value:'PRESERVE_GKM_ROUTE',label:'GKM:s vägval behöver bevaras'}, {value:'UNCERTAIN',label:'Osäkert, behöver undersökas'}];
const reasons = ['','SURFACE','STAIRS','SLOPE','OBSTACLE','ACCESSIBILITY','OUTDATED_GKM','OTHER','UNKNOWN'];
function csvCell(value: string) { return '"' + value.replaceAll('"','""') + '"'; }
function exportCsv(cases: Case[], reviews: Record<string,Review>) {
  const header = ['case_id','start_gid','end_gid','grid_cell','review_decision','reason_category','comment','reviewer'];
  const lines = [header.join(';'), ...cases.filter(c=>reviews[c.case_id]?.decision).map(c=>{
    const r = reviews[c.case_id];
    return [c.case_id,c.start_gid,c.end_gid,c.grid_cell,r.decision,r.reason,r.comment,r.reviewer].map(x=>csvCell(String(x ?? ''))).join(';');
  })];
  const blob = new Blob(['\\uFEFF'+lines.join('\\r\\n')],{type:'text/csv;charset=utf-8'});
  const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href=url; link.download='walk_review_decisions.csv'; link.click(); URL.revokeObjectURL(url);
}
export default function App() {
  const mapNode = useRef<HTMLDivElement>(null);
  const mapRef = useRef<OLMap|null>(null);
  const baseLayerRef = useRef<TileLayer<OSM|XYZ>|null>(null);
  const [baseMap,setBaseMap] = useState<'osm'|'aerial'>('osm');
  const [activeView,setActiveView] = useState<'overview'|'map'>('map');
  const [municipalityMinCount,setMunicipalityMinCount] = useState(100);
  const [municipalitySort,setMunicipalitySort] = useState<'low'|'high'|'partial'|'total'|'name'|'add'|'addUnknown'>('low');

  const gkmSource = useRef(new VectorSource()); const otpSource = useRef(new VectorSource()); const addSource = useRef(new VectorSource()); const stopSource = useRef(new VectorSource());
  const selectedRef = useRef(''); const clusterModeRef = useRef(false);
  const popupNode = useRef<HTMLDivElement>(null);
  const [pointInfo,setPointInfo] = useState<{id:string;role:string}|null>(null);
  const [inspected,setInspected] = useState<'stop'|'gkm'|'otp'|null>(null);
  const [clusters,setClusters] = useState<Cluster[]>([]); const [clusterId,setClusterId] = useState(''); const [showClusterAll,setShowClusterAll] = useState(true);
  const [reviewPanelOpen,setReviewPanelOpen] = useState(true); const [data,setData] = useState<Data|null>(null); const [error,setError] = useState('');
  const [selected,setSelected] = useState('');
  const [reviews,setReviews] = useState<Record<string,Review>>(() => {
    try {
      const saved = localStorage.getItem('gkm-osm-reviews-v1');
      if (!saved) return {};
      const parsed: unknown = JSON.parse(saved);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      return parsed as Record<string,Review>;
    } catch {
      return {};
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem('gkm-osm-reviews-v1', JSON.stringify(reviews));
    } catch (err) {
      console.error('Kunde inte spara granskningar lokalt', err);
    }
  }, [reviews]);
  selectedRef.current=selected; clusterModeRef.current=Boolean(clusterId&&showClusterAll);
  const [visibleLimit,setVisibleLimit] = useState(150);
  const [copiedId,setCopiedId] = useState("");
  const [caseQuery,setCaseQuery] = useState("");
  const [lengthRange,setLengthRange] = useState<number|null>(null);
  const [qualityFilter,setQualityFilter] = useState('ALL'); const [filter,setFilter] = useState('ALL'); const [municipalitiesSelected,setMunicipalitiesSelected] = useState<string[]>([]); const [municipalityQuery,setMunicipalityQuery] = useState(''); const [addGeometryMode,setAddGeometryMode] = useState<'overlap'|'source'|'both'>('overlap'); const [showGkm,setShowGkm] = useState(true); const [showOtp,setShowOtp] = useState(true); const [showPoints,setShowPoints] = useState(true); const [showAdd,setShowAdd] = useState(true);
  useEffect(()=>{fetch(`${import.meta.env.BASE_URL}add-shortcuts-clusters.json`).then(r=>r.ok?r.json():null).then(d=>{if(d?.clusters)setClusters(d.clusters);}).catch(()=>{});},[]);
  useEffect(()=>{fetch(`${import.meta.env.BASE_URL}review-data.json`).then(r=>{if(!r.ok)throw Error('Ingen granskningsdata hittades. Kör exportscriptet.');return r.json();}).then((d:Data)=>{setData(d);setSelected(d.cases[0]?.case_id ?? '');}).catch(e=>setError(String(e)));},[]);
  useEffect(()=>{
    if(!mapNode.current)return;
    const popup = new Overlay({element:popupNode.current!,offset:[0,-18],positioning:'bottom-center',stopEvent:false});
    const baseLayer = new TileLayer({source:new OSM()});
    baseLayerRef.current = baseLayer;
    const map = new OLMap({target:mapNode.current,layers:[
      baseLayer,
      new VectorLayer({source:gkmSource.current,style:feature=>new Style({stroke:new Stroke({color:clusterModeRef.current&&feature.get('case_id')!==selectedRef.current?'rgba(37,99,235,0.20)':'#2563eb',width:!clusterModeRef.current||feature.get('case_id')===selectedRef.current?6:2})})}),
      new VectorLayer({source:otpSource.current,style:feature=>new Style({stroke:new Stroke({color:clusterModeRef.current&&feature.get('case_id')!==selectedRef.current?'rgba(234,88,12,0.20)':'#ea580c',width:!clusterModeRef.current||feature.get('case_id')===selectedRef.current?5:2,lineDash:[8,5]})})}),
      new VectorLayer({source:addSource.current,style:feature=>new Style({stroke:new Stroke({color:feature.get('geometry_role')==='source'?'#a21caf':'#db2777',width:feature.get('geometry_role')==='source'?3:7,lineDash:feature.get('geometry_role')==='source'?[7,5]:undefined})})}),
      new VectorLayer({source:stopSource.current,style:feature=>{
        const start=feature.get('role')==='start';
        const active=!clusterModeRef.current||feature.get('case_id')===selectedRef.current;
        return new Style({image:new CircleStyle({radius:active?11:3,fill:new Fill({color:active?(start?'#15803d':'#b91c1c'):'rgba(100,116,139,0.35)'}),stroke:new Stroke({color:active?'#fff':'rgba(100,116,139,0.35)',width:active?2:1})}),
          text:active?new Text({text:start?'A':'B',font:'bold 12px sans-serif',fill:new Fill({color:'#fff'})}):undefined});
      }})
    ],overlays:[popup],view:new View({center:[1300000,8100000],zoom:5}),controls:defaultControls()});
    map.on('singleclick',event=>{
      const hits: {feature: any; kind: 'stop'|'gkm'|'otp'}[]=[];
      map.forEachFeatureAtPixel(event.pixel,(feature,layer)=>{if(layer?.getSource()===stopSource.current)hits.push({feature,kind:'stop'});else if(layer?.getSource()===gkmSource.current)hits.push({feature,kind:'gkm'});else if(layer?.getSource()===otpSource.current)hits.push({feature,kind:'otp'});},{hitTolerance:8});
      const feature=hits[0]?.kind==='stop'?hits[0].feature:null;
      setInspected(hits[0]?.kind??null);
      if(feature){setPointInfo({id:String(feature.get('stop_point_id')),role:feature.get('role')==='start'?'Startpunkt A':'Slutpunkt B'});popup.setPosition(event.coordinate);}
      else{setPointInfo(null);popup.setPosition(undefined);}
    });
    mapRef.current=map;return ()=>{map.setTarget(undefined);mapRef.current=null;};
  },[]);
  useEffect(()=>{
    if(!data||!selected||!mapRef.current)return;
    const format = new GeoJSON();
    const activeIds = clusterId&&showClusterAll ? new Set(clusters.find(c=>c.cluster_id===clusterId)?.case_ids??[]) : new Set([selected]);
    const load=(collection:FeatureCollection,source:VectorSource,visible:boolean)=>{
      source.clear();if(!visible)return;
      const features=format.readFeatures(collection,{dataProjection:'EPSG:4326',featureProjection:'EPSG:3857'}).filter(f=>activeIds.has(String(f.get('case_id'))));
      source.addFeatures(features);
    };
    load(data.gkm,gkmSource.current,showGkm);load(data.otp,otpSource.current,showOtp);
    for(const source of [gkmSource.current,otpSource.current])source.changed();if(data.add){load(data.add,addSource.current,showAdd);const features=addSource.current.getFeatures();for(const feature of features){const role=feature.get('geometry_role');if((addGeometryMode==='overlap'&&role==='source')||(addGeometryMode==='source'&&role==='overlap'))addSource.current.removeFeature(feature);}}else addSource.current.clear();
    stopSource.current.clear();
    if(showPoints&&data.stop_points){
      stopSource.current.addFeatures(format.readFeatures(data.stop_points,{dataProjection:'EPSG:4326',featureProjection:'EPSG:3857'}).filter(f=>activeIds.has(String(f.get('case_id')))));
    }
    stopSource.current.changed();
    setPointInfo(null);
    mapRef.current.getOverlays().item(0)?.setPosition(undefined);
    const extent=createEmpty();
    for(const source of [gkmSource.current,otpSource.current,stopSource.current]){
      const sourceExtent=source.getExtent();
      if(sourceExtent&&!isEmpty(sourceExtent))extend(extent,sourceExtent);
    }
    if(!isEmpty(extent))mapRef.current.getView().fit(extent,{padding:[80,80,80,80],maxZoom:18,duration:250});
  },[data,selected,showGkm,showOtp,showAdd,showPoints,addGeometryMode,clusterId,showClusterAll,clusters]);
  useEffect(()=>{
    const frame = requestAnimationFrame(()=>{
      mapRef.current?.updateSize();
    });
    return ()=>cancelAnimationFrame(frame);
  },[reviewPanelOpen]);

  useEffect(()=>{
    baseLayerRef.current?.setSource(baseMap==='osm'?new OSM():new XYZ({url:'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',attributions:'Tiles © Esri, Maxar, Earthstar Geographics, and the GIS User Community',maxZoom:19,crossOrigin:'anonymous'}));
  },[baseMap]);
  const hasAddData=Boolean(data?.cases.some(c=>typeof c.contains_add==='boolean'));
  const selectedCase=data?.cases.find(c=>c.case_id===selected);
  const review=reviews[selected] ?? {decision:'',reason:'',comment:'',reviewer:''};
  const update=(key:keyof Review,value:string)=>setReviews(prev=>({...prev,[selected]:{...review,[key]:value}}));
  const [comparisonMode,setComparisonMode]=useState<'distance'|'time'>('distance');
  const [addFilter,setAddFilter]=useState<'all'|'yes'|'no'|'unknown'>('all');
  const lengthRanges = [
    {label:"OTP minst 20 % kortare",min:0,max:0.8},
    {label:"OTP 5–20 % kortare",min:0.8,max:0.95},
    {label:"Ungefär samma längd (±5 %)",min:0.95,max:1.05},
    {label:"OTP 5–20 % längre",min:1.05,max:1.2},
    {label:"OTP 20–50 % längre",min:1.2,max:1.5},
    {label:"OTP 50–100 % längre",min:1.5,max:2},
    {label:"OTP 2–3 gånger så lång",min:2,max:3},
    {label:"OTP mer än 3 gånger så lång",min:3,max:Infinity}
  ];
  const [comparableOnly,setComparableOnly] = useState(false);
  const isComparable=(c:Case)=>[
    "HIGH_GEOMETRY_AGREEMENT",
    "PARTIAL_GEOMETRY_AGREEMENT",
    "LOW_GEOMETRY_AGREEMENT"
  ].includes(c.quality_category??"");
  const lengthMatches=(c:Case)=>{
    if(lengthRange===null)return true;
    const range=lengthRanges[lengthRange];
    const ratio=c.otp_60_length_ratio;
    return Boolean(range&&typeof ratio==="number"&&Number.isFinite(ratio)&&ratio>0&&ratio>=range.min&&ratio<range.max);
  };
  const qualityMatches=(c:Case)=>qualityFilter==='ALL'||c.quality_category===qualityFilter;
  const addMatches=(c:Case)=>addFilter==='all'||(addFilter==='yes'?c.contains_add===true:addFilter==='no'?c.contains_add===false:c.contains_add==null);
  const metricForRaw=(raw:unknown):number|null=>{if(raw===null||raw===undefined||raw==='')return null;const n=Number(raw);return Number.isFinite(n)&&n>=0?n:null;};
  const classifyCase=(c:Case)=>{if(comparisonMode==='distance')return c.severity_band;if(c.severity_band==='NOT_ELIGIBLE'||c.severity_band==='NO_ROUTE')return c.severity_band;const g=metricForRaw(c.details?.duration_seconds),o=metricForRaw(c.details?.otp_duration_s);if(g===null||o===null||g<=0||o<=0)return 'OTHER';const ratio=o/g;return ratio<.5?'VERY_SHORT':ratio<.75?'MODERATELY_SHORT':ratio<.9?'SLIGHTLY_SHORT':ratio<=1.1?'SIMILAR':'LONGER';};
  const categoryLabel=(value:string)=>{const labels:Record<string,string>={SIMILAR:'Likvärdig tid (±10 %)',SLIGHTLY_SHORT:'OTP 10–25 % snabbare',MODERATELY_SHORT:'OTP 25–50 % snabbare',VERY_SHORT:'OTP över 50 % snabbare',LONGER:'OTP över 10 % långsammare',OTHER:'Övriga/ej tidsjämförbara'};return comparisonMode==='time'?(labels[value]??categoryOptions.find(o=>o.value===value)?.label??value):(categoryOptions.find(o=>o.value===value)?.label??value);};
  const municipalities=useMemo(()=>{const m=new globalThis.Map<string,string>();for(const c of data?.cases??[])for(const v of c.municipalities??[])m.set(v.number,v.name);return [...m].sort((a,b)=>a[1].localeCompare(b[1],'sv'));},[data]);
  const municipalityCounts=useMemo(()=>{const result:Record<string,number>={};for(const c of data?.cases??[]){if((filter!=='ALL'&&classifyCase(c)!==filter)||!addMatches(c)||!qualityMatches(c)||!lengthMatches(c)||(comparableOnly&&!isComparable(c)))continue;const ids=c.municipalities?.map(m=>m.number)??[];for(const id of new Set(ids.length?ids:['UNKNOWN']))result[id]=(result[id]??0)+1;}return result;},[data,filter,addFilter,comparisonMode,qualityFilter,lengthRange,comparableOnly]);
  const municipalityMatches=(c:Case)=>(!municipalitiesSelected.length||municipalitiesSelected.some(number=>number==='UNKNOWN'?!(c.municipalities?.length):c.municipalities?.some(m=>m.number===number)));
  const clusterIds=useMemo(()=>new Set(clusters.find(c=>c.cluster_id===clusterId)?.case_ids??[]),[clusters,clusterId]);
  const cases=useMemo(()=>data?.cases.filter(c=>(!clusterId||clusterIds.has(c.case_id))&&municipalityMatches(c)&&addMatches(c)&&qualityMatches(c)&&lengthMatches(c)&&(!comparableOnly||isComparable(c))&&(filter==='ALL'||classifyCase(c)===filter)&&(!caseQuery.trim()||[c.start_gid,c.end_gid,c.case_id].some(v=>String(v??"").toLocaleLowerCase("sv").includes(caseQuery.trim().toLocaleLowerCase("sv")))))??[],[data,filter,municipalitiesSelected,addFilter,comparisonMode,qualityFilter,lengthRange,comparableOnly,clusterId,clusterIds,caseQuery]);
  const counts=useMemo(()=>Object.fromEntries(categoryOptions.map(option=>[option.value,data?.cases.filter(c=>((!municipalitiesSelected.length||municipalitiesSelected.some(number=>number==='UNKNOWN'?!(c.municipalities?.length):c.municipalities?.some(m=>m.number===number))))&&addMatches(c)&&qualityMatches(c)&&lengthMatches(c)&&(!comparableOnly||isComparable(c))&&(option.value==='ALL'||classifyCase(c)===option.value)).length??0])),[data,municipalitiesSelected,addFilter,comparisonMode,qualityFilter,lengthRange,comparableOnly]);
  type OverviewSelection = {
    quality?: string;
    municipality?: string;
    add?: 'all'|'yes'|'no'|'unknown';
    length?: number|null;
    comparable?: boolean;
  };
  const activeFilterCount=[
    qualityFilter!=="ALL",
    comparableOnly&&![
      "HIGH_GEOMETRY_AGREEMENT",
      "PARTIAL_GEOMETRY_AGREEMENT",
      "LOW_GEOMETRY_AGREEMENT"
    ].includes(qualityFilter),
    addFilter!=="all",
    municipalitiesSelected.length>0,
    lengthRange!==null,
    filter!=="ALL",
    Boolean(clusterId),
    Boolean(caseQuery.trim())
  ].filter(Boolean).length;
  const clearAllFilters=()=>{
    setQualityFilter("ALL");
    setFilter("ALL");
    setAddFilter("all");
    setLengthRange(null);
    setComparableOnly(false);
    setMunicipalitiesSelected([]);
    setMunicipalityQuery("");
    setCaseQuery("");
    setClusterId("");
    setShowClusterAll(false);
    setVisibleLimit(150);
  };
  const openOverviewSelection=(selection:OverviewSelection={})=>{
    clearAllFilters();
    const quality=selection.quality??"ALL";
    const add=selection.add??"all";
    const length=selection.length??null;
    const comparable=selection.comparable??false;
    setQualityFilter(quality);
    setAddFilter(add);
    setLengthRange(length);
    setComparableOnly(comparable);
    if(selection.municipality)setMunicipalitiesSelected([selection.municipality]);
    setComparisonMode("distance");
    const range=length===null?null:lengthRanges[length];
    const first=data?.cases.find(c=>
      (quality==="ALL"||c.quality_category===quality)&&
      (add==="all"||(add==="yes"?c.contains_add===true:
        add==="no"?c.contains_add===false:c.contains_add==null))&&
      (!selection.municipality||(
        selection.municipality==="UNKNOWN"
          ? !c.municipalities?.length
          : c.municipalities?.some(m=>m.number===selection.municipality)
      ))&&
      (!comparable||isComparable(c))&&
      (!range||(
        typeof c.otp_60_length_ratio==="number"&&
        Number.isFinite(c.otp_60_length_ratio)&&
        c.otp_60_length_ratio>0&&
        c.otp_60_length_ratio>=range.min&&
        c.otp_60_length_ratio<range.max
      ))
    );
    setSelected(first?.case_id??"");
    setActiveView("map");
    requestAnimationFrame(()=>mapRef.current?.updateSize());
  };
  useEffect(()=>{if(cases.length&&!cases.some(c=>c.case_id===selected))setSelected(cases[0].case_id);},[cases,selected]);
  const reviewed=Object.values(reviews).filter(r=>r.decision).length;
  const [tab,setTab]=useState<'information'|'comparison'|'review'>('information');
  const selectedGeometry=inspected==='gkm'?data?.gkm:inspected==='otp'?data?.otp:null;
  const selectedProperties=selectedGeometry?.features.find(f=>f.properties?.case_id===selected)?.properties;
  const metricFor=(c:Case,key:string)=>{const raw=c.details?.[key];if(raw===null||raw===undefined||raw==='')return null;const n=Number(raw);return Number.isFinite(n)&&n>=0?n:null;};
  const metric=(key:string)=>{const raw=selectedCase?.details?.[key];if(raw===null||raw===undefined||raw==='')return null;const n=Number(raw);return Number.isFinite(n)&&n>=0?n:null;};
  const gkmValue=comparisonMode==='distance'?metric('gkm_distance_m'):metric('duration_seconds');
  const otpValue=comparisonMode==='distance'?metric('otp_distance_m'):metric('otp_duration_s');
  const metricFormat=(n:number|null)=>n===null?'Ej tillgängligt':comparisonMode==='distance'?n.toLocaleString('sv-SE',{maximumFractionDigits:1})+' m':Math.floor(n/60)+' min '+Math.round(n%60)+' s';
  const metricDifference=gkmValue!==null&&otpValue!==null?otpValue-gkmValue:null;
  const metricPercent=metricDifference!==null&&gkmValue!==null&&gkmValue>0?100*metricDifference/gkmValue:null;
  const comparisonFor=(c:Case)=>{const g=metricFor(c,comparisonMode==='distance'?'gkm_distance_m':'duration_seconds');const o=metricFor(c,comparisonMode==='distance'?'otp_distance_m':'otp_duration_s');if(g===null||o===null||g<=0)return 'Ingen jämförelse';const percent=(o/g-1)*100;return (percent>0?'+':'')+percent.toLocaleString('sv-SE',{maximumFractionDigits:1})+' % '+(comparisonMode==='distance'?'sträcka':'tid');};
  const qualityLabel=(value:string|undefined)=>qualityOptions.find(o=>o.value===value)?.label??'Ej klassificerad';
  const qualityPercent=(key:string)=>{
    const raw=selectedCase?.details?.[key];
    if(raw===null||raw===undefined||raw==='')return 'Ej tillgängligt';
    const n=Number(raw);
    return Number.isFinite(n)?n.toLocaleString('sv-SE',{maximumFractionDigits:1})+' %':'Ej tillgängligt';
  };
  const qualityMeters=(key:string)=>{
    const raw=selectedCase?.details?.[key];
    if(raw===null||raw===undefined||raw==='')return 'Ej tillgängligt';
    const n=Number(raw);
    return Number.isFinite(n)?n.toLocaleString('sv-SE',{maximumFractionDigits:1})+' m':'Ej tillgängligt';
  };
  const detail=(name:string,value:unknown)=><p><strong>{name}:</strong> {value===undefined||value===null||value===''?'Ej tillgängligt':String(value)}</p>;
  return <div className="app"><header><div><div className="eyebrow">Team Geografi · pilot</div><h1>Utvärdering av OSM som alternativ till GKM:s gångvägar</h1><p>Vi jämför gångvägar beräknade med OpenStreetMap (OSM) och OpenTripPlanner (OTP) med befintliga gångvägar i GKM för att bedöma hur väl OSM kan ersätta dagens underlag.</p></div><nav className="main-view-tabs" aria-label="Huvudvy"><button type="button" className={activeView==="overview"?"active":""} aria-current={activeView==="overview"?"page":undefined} onClick={()=>setActiveView("overview")}>Översikt</button><button type="button" className={activeView==="map"?"active":""} aria-current={activeView==="map"?"page":undefined} onClick={()=>setActiveView("map")}>Karta och granskning</button></nav><div className="header-actions"><button className="primary" disabled={!reviewed} onClick={()=>data&&exportCsv(data.cases,reviews)}>Exportera bedömningar ({reviewed})</button></div></header><section className="population-overview" hidden={activeView!=="overview"}>
  <h2>Populationsöversikt</h2>
  <p>Geometrisk jämförelse mellan GKM och OTP/OSM. Samtliga riktade gånglänkar ingår.</p>
  {data && (() => {
    const counts = Object.fromEntries(
      qualityOptions.filter(o=>o.value!=="ALL").map(o=>[
        o.value, data.cases.filter(c=>c.quality_category===o.value).length
      ])
    );
    const total = data.cases.length;
    const comparable = (counts.HIGH_GEOMETRY_AGREEMENT||0)
      +(counts.PARTIAL_GEOMETRY_AGREEMENT||0)
      +(counts.LOW_GEOMETRY_AGREEMENT||0);
    const pct = (n:number,d:number) => d ? (100*n/d).toLocaleString("sv-SE",{maximumFractionDigits:1})+" %" : "–";
    const fmt = (n:number) => n.toLocaleString("sv-SE");
    const categories = [
      {key:"HIGH_GEOMETRY_AGREEMENT",label:"Hög överensstämmelse",color:"#277a61"},
      {key:"PARTIAL_GEOMETRY_AGREEMENT",label:"Delvis överensstämmelse",color:"#d6a044"},
      {key:"LOW_GEOMETRY_AGREEMENT",label:"Låg överensstämmelse",color:"#c55b52"}
    ];
    const exclusions = [
      ["NO_CURRENT_ENDPOINTS","Saknar aktuella ändpunkter"],
      ["TIME_ONLY_NO_GKM_GEOMETRY","Endast GKM-tid, ingen geometri"],
      ["NO_OSM_ROUTE","Ingen OTP-rutt"],
      ["GEOMETRY_NOT_COMPARABLE","Geometri ej jämförbar"]
    ];

    const lengthCases = data.cases.filter(c =>
      categories.some(category => category.key === c.quality_category) &&
      typeof c.otp_60_length_ratio === "number" &&
      Number.isFinite(c.otp_60_length_ratio) &&
      c.otp_60_length_ratio > 0
    );
    const lengthValues = lengthCases
      .map(c => c.otp_60_length_ratio as number)
      .sort((a,b) => a-b);
    const lengthPercentile = (p:number) =>
      lengthValues.length
        ? lengthValues[Math.round((lengthValues.length-1)*p)]
        : null;
    const lengthFmt = (n:number|null) =>
      n===null ? "–" : n.toLocaleString("sv-SE",{maximumFractionDigits:3});
    const lengthBins = [
      {label:"OTP minst 20 % kortare", min:0, max:0.8},
      {label:"OTP 5–20 % kortare", min:0.8, max:0.95},
      {label:"Ungefär samma längd (±5 %)", min:0.95, max:1.05},
      {label:"OTP 5–20 % längre", min:1.05, max:1.2},
      {label:"OTP 20–50 % längre", min:1.2, max:1.5},
      {label:"OTP 50–100 % längre", min:1.5, max:2},
      {label:"OTP 2–3 gånger så lång", min:2, max:3},
      {label:"OTP mer än 3 gånger så lång", min:3, max:Infinity}
    ].map(bin => {
      const subset = lengthCases.filter(c =>
        (c.otp_60_length_ratio as number)>=bin.min &&
        (c.otp_60_length_ratio as number)<bin.max
      );
      return {
        ...bin,
        total:subset.length,
        counts:categories.map(category=>({
          ...category,
          count:subset.filter(c=>c.quality_category===category.key).length
        }))
      };
    });
    const maxLengthBin = Math.max(1,...lengthBins.map(bin=>bin.total));
    const openLengthRange = (index:number,quality:string="ALL") =>
      openOverviewSelection({length:index,quality});
    const addCounts = {
      yes: data.cases.filter(c=>c.contains_add===true).length,
      no: data.cases.filter(c=>c.contains_add===false).length,
      unknown: data.cases.filter(c=>c.contains_add==null).length
    };
    const addAgreement = (status:boolean) => {
      const subset = data.cases.filter(c=>c.contains_add===status);
      const high = subset.filter(c=>c.quality_category==="HIGH_GEOMETRY_AGREEMENT").length;
      const partial = subset.filter(c=>c.quality_category==="PARTIAL_GEOMETRY_AGREEMENT").length;
      const low = subset.filter(c=>c.quality_category==="LOW_GEOMETRY_AGREEMENT").length;
      return {high,partial,low,total:high+partial+low};
    };
    const withAdd = addAgreement(true);
    const withoutAdd = addAgreement(false);
    const municipalityStats = new globalThis.Map<string,{
      name:string;number:string;total:number;comparable:number;high:number;partial:number;low:number;addYes:number;addNo:number;addUnknown:number;addComparable:number;addLow:number;noAddComparable:number;noAddLow:number
    }>();
    for (const c of data.cases) {
      const names = [...new Set((c.municipalities||[]).map(m=>m.name).filter(Boolean))];
      for (const name of names.length ? names : ["Okänd kommun"]) {
        const number = c.municipalities?.find(m=>m.name===name)?.number ?? "UNKNOWN";
        const row = municipalityStats.get(name) || {
          name,number,total:0,comparable:0,high:0,partial:0,low:0,addYes:0,addNo:0,addUnknown:0,addComparable:0,addLow:0,noAddComparable:0,noAddLow:0
        };
        row.total++;
        if(c.contains_add===true) row.addYes++;
        else if(c.contains_add===false) row.addNo++;
        else row.addUnknown++;
        if (c.quality_category==="HIGH_GEOMETRY_AGREEMENT") {
          row.high++;row.comparable++;
        } else if (c.quality_category==="PARTIAL_GEOMETRY_AGREEMENT") {
          row.partial++;row.comparable++;
        } else if (c.quality_category==="LOW_GEOMETRY_AGREEMENT") {
          row.low++;row.comparable++;
        }
        if (
          c.quality_category==="HIGH_GEOMETRY_AGREEMENT" ||
          c.quality_category==="PARTIAL_GEOMETRY_AGREEMENT" ||
          c.quality_category==="LOW_GEOMETRY_AGREEMENT"
        ) {
          if (c.contains_add===true) {
            row.addComparable++;
            if(c.quality_category==="LOW_GEOMETRY_AGREEMENT") row.addLow++;
          } else if(c.contains_add===false) {
            row.noAddComparable++;
            if(c.quality_category==="LOW_GEOMETRY_AGREEMENT") row.noAddLow++;
          }
        }
        municipalityStats.set(name,row);
      }
    }
    const municipalityRows = [...municipalityStats.values()]
      .filter(r=>r.name!=="Okänd kommun" && r.comparable>=municipalityMinCount)
      .sort((a,b)=>{
        if(municipalitySort==="name") return a.name.localeCompare(b.name,"sv");
        if(municipalitySort==="total") return b.total-a.total;
        if(municipalitySort==="add")
          return b.addYes/Math.max(b.total,1)-a.addYes/Math.max(a.total,1) || b.total-a.total;
        if(municipalitySort==="addUnknown")
          return b.addUnknown/Math.max(b.total,1)-a.addUnknown/Math.max(a.total,1) || b.total-a.total;
        const numerator = (r:typeof a) =>
          municipalitySort==="high"?r.high:municipalitySort==="partial"?r.partial:r.low;
        const difference = numerator(b)/Math.max(b.comparable,1)
          -numerator(a)/Math.max(a.comparable,1);
        return difference || b.comparable-a.comparable;
      });
    const unknownMunicipality = municipalityStats.get("Okänd kommun");
    const openMunicipality = (number:string,quality:string="ALL") =>
      openOverviewSelection({municipality:number,quality});
    return <>
      <div className="overview-kpis">
        <button type="button" className="overview-kpi overview-clickable" onClick={()=>openOverviewSelection()}><span>Alla gånglänkar</span><strong>{fmt(total)}</strong><small>Riktade GKM-länkar</small></button>
        <button type="button" className="overview-kpi overview-clickable" onClick={()=>openOverviewSelection({comparable:true})}><span>Jämförbar geometri</span><strong>{fmt(comparable)}</strong><small>{pct(comparable,total)} av samtliga</small></button>
        <button type="button" className="overview-kpi overview-clickable" onClick={()=>openOverviewSelection({quality:"HIGH_GEOMETRY_AGREEMENT"})}><span>Hög överensstämmelse</span><strong>{pct(counts.HIGH_GEOMETRY_AGREEMENT||0,comparable)}</strong><small>Av geometriskt jämförbara</small></button>
        <button type="button" className="overview-kpi overview-clickable" onClick={()=>openOverviewSelection({quality:"LOW_GEOMETRY_AGREEMENT"})}><span>Låg överensstämmelse</span><strong>{pct(counts.LOW_GEOMETRY_AGREEMENT||0,comparable)}</strong><small>Av geometriskt jämförbara</small></button>
      </div>
      <div className="overview-panels">
        <section className="overview-panel">
          <h3>Geometrisk överensstämmelse</h3>
          <p>Andelar beräknas på de {fmt(comparable)} länkar där geometrierna kan jämföras.</p>
          <div className="overview-stacked-bar">
            {categories.map(c=><button
      type="button"
      className="overview-bar-action"
      key={c.key}
      disabled={!(counts[c.key]||0)}
      onClick={()=>openOverviewSelection({quality:c.key})}
      style={{
        width:`${100*(counts[c.key]||0)/Math.max(comparable,1)}%`,
        background:c.color
      }}
      title={`Visa ${fmt(counts[c.key]||0)} gångvägar: ${c.label}`}
      aria-label={`Visa gångvägar med ${c.label.toLowerCase()}`}
    />)}
          </div>
          {categories.map(c=><button type="button" className="overview-category-row overview-clickable" key={c.key} onClick={()=>openOverviewSelection({quality:c.key})}>
            <span className="overview-dot" style={{background:c.color}}/>
            <span>{c.label}</span><strong>{fmt(counts[c.key]||0)}</strong>
            <span>{pct(counts[c.key]||0,comparable)}</span>
          </button>)}
        </section>
        <section className="overview-panel">
          <h3>Utanför geometrisk jämförelse</h3>
          <p>{fmt(total-comparable)} länkar saknar förutsättningar för en jämförbar geometri.</p>
          {exclusions.map(([key,label])=><button type="button" className="overview-category-row overview-clickable" key={key} onClick={()=>openOverviewSelection({quality:key})}>
            <span>{label}</span><strong>{fmt(counts[key]||0)}</strong>
            <span>{pct(counts[key]||0,total)}</span>
          </button>)}
          <p className="overview-note">Att en länk inte kan jämföras innebär inte i sig att GKM-informationen är felaktig.</p>
        </section>
      </div>

      <section className="overview-panel length-analysis-panel">
        <h3>Skillnader i gångvägarnas längd</h3>
        <p>OTP:s beräknade gångvägslängd i förhållande till GKM. Analysen omfattar {fmt(lengthCases.length)} geometriskt jämförbara gångvägar med giltig längdkvot.</p>
        <div className="add-summary">
          <div><span>Median, OTP/GKM</span><strong>{lengthFmt(lengthPercentile(0.5))}</strong><small>Hälften av gångvägarna ligger under detta värde</small></div>
          <div><span>90:e percentilen</span><strong>{lengthFmt(lengthPercentile(0.9))}</strong><small>90 % ligger på eller under värdet</small></div>
          <div><span>95:e percentilen</span><strong>{lengthFmt(lengthPercentile(0.95))}</strong><small>95 % ligger på eller under värdet</small></div>
        </div>
        <h4>Fördelning av längdskillnader</h4>
        <p>Staplarna visar antal gångvägar per intervall, fördelat efter geometrisk överensstämmelse.</p>
        <div className="length-bin-chart">
          {lengthBins.map(bin=><div className="length-bin-row" key={bin.label}>
            <button type="button" className="length-bin-label length-bin-action"
              onClick={()=>openLengthRange(lengthBins.indexOf(bin))}
              title={`Visa alla ${fmt(bin.total)} gångvägar i intervallet`}>
              {bin.label}
            </button>
            <div className="length-bin-track" title={`${fmt(bin.total)} gångvägar (${pct(bin.total,lengthCases.length)})`}>
              <div className="length-bin-bar" style={{width:`${100*bin.total/maxLengthBin}%`}}>
                {bin.counts.map(category=><button
                  type="button"
                  key={category.key}
                  className="length-bin-segment"
                  disabled={!category.count}
                  onClick={()=>openLengthRange(lengthBins.indexOf(bin),category.key)}
                  style={{
                    width:bin.total?`${100*category.count/bin.total}%`:"0%",
                    background:category.color
                  }}
                  title={`Visa ${fmt(category.count)} gångvägar: ${bin.label}, ${category.label}`}
                  aria-label={`Visa ${fmt(category.count)} gångvägar: ${bin.label}, ${category.label}`}
                />)}
              </div>
            </div>
            <strong className="length-bin-count">{fmt(bin.total)}</strong>
            <span className="length-bin-percent">{pct(bin.total,lengthCases.length)}</span>
          </div>)}
        </div>
        <div className="add-agreement-percentages">
          {categories.map(category=><span key={category.key}>
            <span className="overview-dot" style={{background:category.color,display:"inline-block",marginRight:6}}/>
            {category.label}
          </span>)}
        </div>
        <p className="overview-note">Längdkvot 1 innebär samma längd. Ett värde över 1 innebär att OTP:s väg är längre än GKM:s. Längdlikhet innebär inte nödvändigtvis att gångvägarna följer samma sträckning. Intervallen är beskrivande och utgör inte acceptanskriterier.</p>
      </section>
      <section className="overview-panel add-analysis-panel">
        <h3>ADD-förbindelser i GKM:s gångvägar</h3>
        <p>ADD visar om den analyserade GKM-gångvägen innehåller minst en kompletterande ADD-förbindelse. Det är inte ett mått på OSM:s kvalitet.</p>
        <div className="add-summary">
          <button type="button" className="add-summary-action" onClick={()=>openOverviewSelection({add:"yes"})}><span>Innehåller ADD</span><strong>{fmt(addCounts.yes)}</strong><small>{pct(addCounts.yes,total)} av alla gångvägar</small></button>
          <button type="button" className="add-summary-action" onClick={()=>openOverviewSelection({add:"no"})}><span>Innehåller inte ADD</span><strong>{fmt(addCounts.no)}</strong><small>{pct(addCounts.no,total)} av alla gångvägar</small></button>
          <button type="button" className="add-summary-action" onClick={()=>openOverviewSelection({add:"unknown"})}><span>Okänd ADD-status</span><strong>{fmt(addCounts.unknown)}</strong><small>{pct(addCounts.unknown,total)} av alla gångvägar</small></button>
        </div>
        <h4>Geometrisk överensstämmelse med respektive utan ADD</h4>
        <p>Andelarna nedan beräknas endast på geometriskt jämförbara gångvägar med känd ADD-status.</p>
        {([
          ["Innehåller ADD",withAdd],
          ["Innehåller inte ADD",withoutAdd]
        ] as const).map(([label,row])=><div className="add-agreement-row" key={label}>
          <div className="add-agreement-heading"><strong>{label}</strong><span>{fmt(row.total)} jämförbara</span></div>
          <div className="overview-stacked-bar">
            {categories.map(category=>{
              const count=category.key==="HIGH_GEOMETRY_AGREEMENT"?row.high:
                category.key==="PARTIAL_GEOMETRY_AGREEMENT"?row.partial:row.low;
              return <button type="button"
                key={category.key}
                className="overview-bar-action"
                disabled={!count}
                onClick={()=>openOverviewSelection({
                  add:label==="Innehåller ADD"?"yes":"no",
                  quality:category.key
                })}
                style={{width:row.total?`${100*count/row.total}%`:"0%",background:category.color}}
                title={`Visa ${fmt(count)} gångvägar: ${label}, ${category.label}`}
                aria-label={`Visa ${label}, ${category.label}`}/>;
            })}
          </div>
          <div className="add-agreement-percentages">
            <span>Hög: {pct(row.high,row.total)}</span>
            <span>Delvis: {pct(row.partial,row.total)}</span>
            <span>Låg: {pct(row.low,row.total)}</span>
          </div>
        </div>)}
        <p className="overview-note">Skillnader mellan grupperna kan påverkas av exempelvis kommun, gångvägarnas egenskaper och OSM:s nätstruktur. ADD-förekomst visar inte i sig orsaken till en avvikelse.</p>
      </section>
      <section className="overview-panel municipality-panel">
        <h3>OSM:s geometriska överensstämmelse med GKM per kommun</h3>
        <p>Andelarna för hög, delvis och låg överensstämmelse beräknas endast på geometriskt jämförbara länkar inom respektive kommun.</p>
        <div className="municipality-controls">
          <label>Minst antal jämförbara länkar
            <select value={municipalityMinCount} onChange={e=>setMunicipalityMinCount(Number(e.target.value))}>
              <option value={0}>Alla kommuner</option>
              <option value={30}>30</option>
              <option value={100}>100</option>
              <option value={300}>300</option>
              <option value={500}>500</option>
            </select>
          </label>
          <label>Sortera efter
            <select value={municipalitySort} onChange={e=>setMunicipalitySort(e.target.value as typeof municipalitySort)}>
              <option value="low">Högst andel låg överensstämmelse</option>
              <option value="high">Högst andel hög överensstämmelse</option>
              <option value="partial">Högst andel delvis överensstämmelse</option>
              <option value="total">Flest gånglänkar</option>
              <option value="add">Högst ADD-andel</option>
              <option value="addUnknown">Högst andel okänd ADD-status</option>
              <option value="name">Kommunnamn</option>
            </select>
          </label>
        </div>
        <p>Visar {municipalityRows.length} av {municipalityStats.size-(unknownMunicipality?1:0)} kommuner.</p>
        <p className="overview-note">ADD-andel och okänd ADD-status beräknas på samtliga analyserade gångvägar. Jämförelsen med/utan ADD omfattar endast geometriskt jämförbara gångvägar. Grupper med färre än 30 jämförbara markeras med †.</p>
        <div className="municipality-table-wrap">
          <table className="municipality-table">
            <thead><tr>
              <th>Kommun</th><th>Alla länkar</th><th>Jämförbara</th>
              <th>Andel jämförbara</th><th>Hög</th><th>Delvis</th><th>Låg</th><th>ADD-andel</th><th>Okänd ADD-status</th><th>Låg med ADD</th><th>Låg utan ADD</th><th title="Skillnad i procentenheter: andel låg geometrisk överensstämmelse med ADD minus andel utan ADD">Skillnad (pe)</th>
            </tr></thead>
            <tbody>
              {municipalityRows.map(r=><tr key={r.name}>
                <td><button type="button" className="municipality-link"
                  onClick={()=>openMunicipality(r.number)}>{r.name}</button></td>
                <td>{fmt(r.total)}</td>
                <td><button type="button" className="municipality-link" onClick={()=>openOverviewSelection({municipality:r.number,comparable:true})}>{fmt(r.comparable)}</button></td>
                <td><button type="button" className="municipality-link" onClick={()=>openOverviewSelection({municipality:r.number,comparable:true})}>{pct(r.comparable,r.total)}</button></td>
                <td><button type="button" className="municipality-link" onClick={()=>openMunicipality(r.number,"HIGH_GEOMETRY_AGREEMENT")}>{pct(r.high,r.comparable)}</button></td>
                <td><button type="button" className="municipality-link" onClick={()=>openMunicipality(r.number,"PARTIAL_GEOMETRY_AGREEMENT")}>{pct(r.partial,r.comparable)}</button></td>
                <td><button type="button" className="municipality-link municipality-low" onClick={()=>openMunicipality(r.number,"LOW_GEOMETRY_AGREEMENT")}>{pct(r.low,r.comparable)}</button></td>
                <td title={`${fmt(r.addYes)} av ${fmt(r.total)} gångvägar innehåller ADD`}><button type="button" className="municipality-link" onClick={()=>openOverviewSelection({municipality:r.number,add:"yes"})}>{pct(r.addYes,r.total)}</button></td>
                <td title={`${fmt(r.addUnknown)} av ${fmt(r.total)} gångvägar har okänd ADD-status`}><button type="button" className="municipality-link" onClick={()=>openOverviewSelection({municipality:r.number,add:"unknown"})}>{pct(r.addUnknown,r.total)}</button></td>
                <td title={`${fmt(r.addLow)} av ${fmt(r.addComparable)} jämförbara gångvägar med ADD har låg överensstämmelse`}>
                  <button type="button" className="municipality-link" onClick={()=>openOverviewSelection({municipality:r.number,add:"yes",quality:"LOW_GEOMETRY_AGREEMENT"})}>{pct(r.addLow,r.addComparable)} ({fmt(r.addComparable)}){r.addComparable<30?" †":""}</button>
                </td>
                <td title={`${fmt(r.noAddLow)} av ${fmt(r.noAddComparable)} jämförbara gångvägar utan ADD har låg överensstämmelse`}>
                  <button type="button" className="municipality-link" onClick={()=>openOverviewSelection({municipality:r.number,add:"no",quality:"LOW_GEOMETRY_AGREEMENT"})}>{pct(r.noAddLow,r.noAddComparable)} ({fmt(r.noAddComparable)}){r.noAddComparable<30?" †":""}</button>
                </td>
                <td title="Skillnad i procentenheter: med ADD minus utan ADD">
                  {r.addComparable&&r.noAddComparable
                    ? `${(100*(r.addLow/r.addComparable-r.noAddLow/r.noAddComparable)).toLocaleString("sv-SE",{maximumFractionDigits:1,signDisplay:"always"})} pe${Math.min(r.addComparable,r.noAddComparable)<30?" †":""}`
                    : "–"}
                </td>
              </tr>)}
            </tbody>
          </table>
        </div>
        <p className="overview-note">
          <strong>Så tolkar du tabellen:</strong> Skillnad (pe) anger skillnaden
          i procentenheter mellan andelen gångvägar med låg geometrisk
          överensstämmelse med ADD och motsvarande andel utan ADD.
          Ett positivt värde innebär att andelen är högre med ADD.
          <strong> †</strong> markerar att underlaget omfattar färre än
          30 jämförbara gångvägar i minst en berörd grupp.
          Skillnaderna visar samband, inte orsakssamband.
        </p>
        {unknownMunicipality && <p className="overview-note">
          {fmt(unknownMunicipality.total)} länkar saknar kommun och ingår i populationsstatistiken men inte i kommunrankningen.
        </p>}
      </section>
    </>;
  })()}
</section><div className="map-view-container" hidden={activeView!=="map"}><main className={reviewPanelOpen?"":"review-collapsed"}><aside className="sidebar"><div className="route-list-section"><h2>Sträckor ({cases.length.toLocaleString("sv-SE")})</h2>
<div className="comparison-toggle" role="group" aria-label="Jämför efter"><button type="button" className={comparisonMode==="distance"?"active":""} aria-pressed={comparisonMode==="distance"} onClick={()=>setComparisonMode("distance")}>Sträcka</button><button type="button" className={comparisonMode==="time"?"active":""} aria-pressed={comparisonMode==="time"} onClick={()=>setComparisonMode("time")}>Tid</button></div><input className="case-search" type="search" aria-label="Sök sträcka" placeholder="Sök GID eller case-ID…" value={caseQuery} onChange={e=>{setCaseQuery(e.target.value);setVisibleLimit(150);}}/><details className="sidebar-filters">
  <summary>Filter och urval
    {activeFilterCount>0&&<span className="active-filter-count">({activeFilterCount})</span>}
  </summary>
  <div className="sidebar-filter-content">
    {activeFilterCount>0&&
      <div className="filter-active-list">
        <div className="filter-active-heading">
          <strong>Aktiva filter</strong>
          <button type="button" onClick={clearAllFilters}>Rensa alla</button>
        </div>
        <div className="filter-active-tags">
          {qualityFilter!=="ALL"&&
            <button type="button" onClick={()=>setQualityFilter("ALL")}
              title="Ta bort kvalitetsfilter">
              {qualityOptions.find(o=>o.value===qualityFilter)?.label??qualityFilter} ×
            </button>}
          {comparableOnly&&![
            "HIGH_GEOMETRY_AGREEMENT",
            "PARTIAL_GEOMETRY_AGREEMENT",
            "LOW_GEOMETRY_AGREEMENT"
          ].includes(qualityFilter)&&
            <button type="button" onClick={()=>setComparableOnly(false)}>
              Jämförbar geometri ×
            </button>}
          {addFilter!=="all"&&
            <button type="button" onClick={()=>setAddFilter("all")}>
              ADD: {addFilter==="yes"?"Ja":addFilter==="no"?"Nej":"Okänd"} ×
            </button>}
          {municipalitiesSelected.length>0&&
            <button type="button" onClick={()=>setMunicipalitiesSelected([])}>
              Kommuner ({municipalitiesSelected.length}) ×
            </button>}
          {lengthRange!==null&&
            <button type="button" onClick={()=>setLengthRange(null)}>
              Längdkvot: {lengthRanges[lengthRange].label} ×
            </button>}
          {filter!=="ALL"&&
            <button type="button" onClick={()=>setFilter("ALL")}>
              {categoryLabel(filter)} ×
            </button>}
          {clusterId&&
            <button type="button" onClick={()=>{setClusterId("");setShowClusterAll(false);}}>
              Kluster: {clusterId} ×
            </button>}
          {caseQuery.trim()&&
            <button type="button" onClick={()=>setCaseQuery("")}>
              Sökning: {caseQuery.trim()} ×
            </button>}
        </div>
        <small>{cases.length.toLocaleString("sv-SE")} matchande sträckor</small>
      </div>}
<label htmlFor="cluster-select">Granskningskluster</label><select id="cluster-select" value={clusterId} disabled={!clusters.length} onChange={e=>{setClusterId(e.target.value);setFilter('ALL');setAddFilter('all');setMunicipalitiesSelected([]);setVisibleLimit(150);const first=clusters.find(c=>c.cluster_id===e.target.value)?.case_ids[0];if(first)setSelected(first);}}><option value="">Alla gånglänkar</option>{clusters.map(c=><option key={c.cluster_id} value={c.cluster_id}>{c.cluster_id} · {c.directed_cases} fall · {c.add_cases} ADD · max {c.max_saved_m} m</option>)}</select>{clusterId&&<label><input type="checkbox" checked={showClusterAll} onChange={e=>setShowClusterAll(e.target.checked)}/> Visa hela klustret på kartan</label>}{!clusters.length&&<p className="hint">Klusterfil saknas. Kör analysskriptet för kluster igen.</p>}<label htmlFor="add-filter">ADD-länk i GKM-sträckan</label><select id="add-filter" value={addFilter} disabled={!hasAddData} onChange={e=>setAddFilter(e.target.value as "all"|"yes"|"no")}><option value="all">Alla</option><option value="yes">Ja</option><option value="no">Nej</option><option value="unknown">Okänd, GKM-geometri saknas</option></select>{!hasAddData&&<p className="hint">ADD-klassning saknas i exporten. Filtret aktiveras när underlaget kompletterats.</p>}<label htmlFor="municipality-search">Kommuner {municipalitiesSelected.length?(`(${municipalitiesSelected.length} valda)`):'(alla)'}</label><input id="municipality-search" type="search" placeholder="Sök kommun…" value={municipalityQuery} onChange={e=>setMunicipalityQuery(e.target.value)}/><div className="municipality-actions"><button type="button" onClick={()=>setMunicipalitiesSelected([])}>Alla kommuner</button><button type="button" onClick={()=>setMunicipalitiesSelected(municipalities.filter(([,name])=>name.toLocaleLowerCase('sv').includes(municipalityQuery.toLocaleLowerCase('sv'))).map(([number])=>number))}>Välj visade</button></div><div className="municipality-options" role="group" aria-label="Välj kommuner">{municipalities.filter(([,name])=>name.toLocaleLowerCase('sv').includes(municipalityQuery.toLocaleLowerCase('sv'))).map(([number,name])=><label key={number}><input type="checkbox" checked={municipalitiesSelected.includes(number)} onChange={e=>setMunicipalitiesSelected(prev=>e.target.checked?[...prev,number]:prev.filter(x=>x!==number))}/>{name} ({municipalityCounts[number]??0})</label>)}{(!municipalityQuery||'okänd kommun'.includes(municipalityQuery.toLocaleLowerCase('sv')))&&<label><input type="checkbox" checked={municipalitiesSelected.includes('UNKNOWN')} onChange={e=>setMunicipalitiesSelected(prev=>e.target.checked?[...prev,'UNKNOWN']:prev.filter(x=>x!=='UNKNOWN'))}/>Okänd kommun ({municipalityCounts.UNKNOWN??0})</label>}</div><label><input type="checkbox" checked={comparableOnly}
      onChange={e=>{setComparableOnly(e.target.checked);setVisibleLimit(150);}}/>
      Endast geometriskt jämförbara</label>
    <label htmlFor="length-range-filter">Längdkvot OTP/GKM</label>
    <select id="length-range-filter" value={lengthRange===null?"all":String(lengthRange)}
      onChange={e=>{setLengthRange(e.target.value==="all"?null:Number(e.target.value));setVisibleLimit(150);}}>
      <option value="all">Alla längdintervall</option>
      {lengthRanges.map((range,index)=><option key={index} value={index}>{range.label}</option>)}
    </select>
    {lengthRange!==null&&<p className="hint">
      Aktivt längdurval: {lengthRanges[lengthRange].label}.
      <button type="button" onClick={()=>{setLengthRange(null);setVisibleLimit(150);}}> Rensa längdurval</button>
    </p>}
    <label htmlFor="quality-filter">Geometrisk överensstämmelse GKM–OTP</label><select id="quality-filter" value={qualityFilter} onChange={e=>{setQualityFilter(e.target.value);setVisibleLimit(150);}}>{qualityOptions.map(option=><option key={option.value} value={option.value}>{option.label}</option>)}</select><p className="hint">Låg överensstämmelse betyder att OTP:s vägval skiljer sig från GKM, inte att GKM är fel.</p><label htmlFor="severity">Visa fall</label><select id="severity" value={filter} onChange={e=>{const value=e.target.value;setFilter(value);setVisibleLimit(150);const first=data?.cases.find(c=>municipalityMatches(c)&&addMatches(c)&&(value==="ALL"||classifyCase(c)===value));setSelected(first?.case_id??"");}}>{categoryOptions.map(option=><option key={option.value} value={option.value}>{categoryLabel(option.value)} ({counts[option.value]??0})</option>)}</select><div className="filter-counts">{categoryOptions.map(option=><button key={option.value} type="button" className={"filter-count "+(filter===option.value?"active":"")} onClick={()=>{setFilter(option.value);setVisibleLimit(150);const first=data?.cases.find(c=>municipalityMatches(c)&&addMatches(c)&&(option.value==="ALL"||classifyCase(c)===option.value));setSelected(first?.case_id??"");}}><span>{categoryLabel(option.value)}</span><strong>{(counts[option.value]??0).toLocaleString("sv-SE")}</strong></button>)}</div></div></details><div className="case-list">{!data?.category_counts&&<p className="hint">Visar endast granskningsurvalet. Kör exporten för alla gånglänkar för korrekta totaler.</p>}{cases.slice(0,visibleLimit).map(c=><div key={c.case_id} className={'case '+(c.case_id===selected?'active':'')}><div className="case-select" role="button" tabIndex={0} onClick={()=>setSelected(c.case_id)} onKeyDown={e=>{if(e.target===e.currentTarget&&(e.key==="Enter"||e.key===" ")){e.preventDefault();setSelected(c.case_id);}}}><span className="case-endpoint-row"><span className="case-endpoint-value" title={String(c.start_gid)}>{c.start_gid}</span><button type="button" className="case-copy-icon" title={`Kopiera Start-GID: ${c.start_gid}`} aria-label={`Kopiera Start-GID: ${c.start_gid}`} onClick={async(e)=>{e.stopPropagation();try{await navigator.clipboard.writeText(String(c.start_gid));setCopiedId(`${c.case_id}:Start-GID`);}catch{window.prompt("Kopiera ID:",String(c.start_gid));}}}>{copiedId===`${c.case_id}:Start-GID`?"✓":"⧉"}</button><span className="case-arrow">→</span><span className="case-endpoint-value" title={String(c.end_gid)}>{c.end_gid}</span><button type="button" className="case-copy-icon" title={`Kopiera Slut-GID: ${c.end_gid}`} aria-label={`Kopiera Slut-GID: ${c.end_gid}`} onClick={async(e)=>{e.stopPropagation();try{await navigator.clipboard.writeText(String(c.end_gid));setCopiedId(`${c.case_id}:Slut-GID`);}catch{window.prompt("Kopiera ID:",String(c.end_gid));}}}>{copiedId===`${c.case_id}:Slut-GID`?"✓":"⧉"}</button></span><span className="case-municipality">{c.municipalities?.map(m=>m.name).join(", ")||"Okänd kommun"}</span><span className="case-quality">{qualityLabel(c.quality_category)}</span><span className="case-distances">GKM {metricFor(c,comparisonMode==="distance"?"gkm_distance_m":"duration_seconds")?.toLocaleString("sv-SE",{maximumFractionDigits:1})??"–"} {comparisonMode==="distance"?"m":"s"} · OTP {metricFor(c,comparisonMode==="distance"?"otp_distance_m":"otp_duration_s")?.toLocaleString("sv-SE",{maximumFractionDigits:1})??"–"} {comparisonMode==="distance"?"m":"s"}</span><span className="case-comparison">{comparisonFor(c)}</span><span className="case-id-row"><small className="case-id" title={c.case_id}>{c.case_id}</small><button type="button" className="case-copy-icon" title={`Kopiera Case-ID: ${c.case_id}`} aria-label={`Kopiera Case-ID: ${c.case_id}`} onClick={async(e)=>{e.stopPropagation();try{await navigator.clipboard.writeText(String(c.case_id));setCopiedId(`${c.case_id}:Case-ID`);}catch{window.prompt("Kopiera ID:",String(c.case_id));}}}>{copiedId===`${c.case_id}:Case-ID`?"✓":"⧉"}</button></span>{reviews[c.case_id]?.decision&&<span className="done">Bedömd</span>}</div></div>)}{cases.length>visibleLimit&&<button className="case" onClick={()=>setVisibleLimit(n=>n+150)}>Visa fler ({(cases.length-visibleLimit).toLocaleString("sv-SE")} återstår)</button>}</div></div></aside><section className="map-panel"><details className="map-layers"><summary>Kartlager</summary><div className="map-toolbar"><label className="basemap-label">Bakgrundskarta <select aria-label="Bakgrundskarta" value={baseMap} onChange={e=>setBaseMap(e.target.value as "osm"|"aerial")}><option value="osm">OpenStreetMap</option><option value="aerial">Flygfoto (Esri)</option></select></label><label><input type="checkbox" checked={showGkm} onChange={e=>setShowGkm(e.target.checked)}/> <span className="legend blue"/> GKM</label><label><input type="checkbox" checked={showOtp} onChange={e=>setShowOtp(e.target.checked)}/> <span className="legend orange"/> OTP</label><label><input type="checkbox" checked={showAdd} disabled={!data?.add} onChange={e=>setShowAdd(e.target.checked)}/> <span className={`legend ${addGeometryMode==="source"?"add-source":"add-overlap"}`}/> ADD</label><select aria-label="ADD-geometri" value={addGeometryMode} disabled={!data?.add||!showAdd} onChange={e=>setAddGeometryMode(e.target.value as "overlap"|"source"|"both")}><option value="overlap">Matchad ADD-del</option><option value="source">Hela ADD-objekt</option><option value="both">Båda ADD-geometrierna</option></select><label><input type="checkbox" checked={showPoints} onChange={e=>setShowPoints(e.target.checked)}/> <span className="legend point"/> StopPoints</label></div></details><div ref={mapNode} className="map"/>
<div className="map-key" aria-label="Kartförklaring">
  <strong>Kartförklaring</strong>
  {showGkm && <div><span className="map-key-line gkm"/>GKM-gånglänk</div>}
  {showOtp && <div><span className="map-key-line otp"/>OTP-rutt</div>}
  {showAdd && data?.add && (addGeometryMode==="overlap" || addGeometryMode==="both") &&
    <div><span className="map-key-line add-overlap"/>Matchad ADD-del</div>}
  {showAdd && data?.add && (addGeometryMode==="source" || addGeometryMode==="both") &&
    <div><span className="map-key-line add-source"/>Hela ADD-objekt</div>}
  {showPoints && <div><span className="map-key-point start">A</span>Från – startpunkt</div>}
  {showPoints && <div><span className="map-key-point end">B</span>Till – slutpunkt</div>}
</div><div ref={popupNode} className="point-popup">{pointInfo&&<><strong>{pointInfo.role}</strong><div>StopPoint-ID: {pointInfo.id}</div><small>Position från OTP:s analysunderlag</small></>}</div>{error&&<div className="notice">{error}</div>}</section>{!reviewPanelOpen&&<button type="button" className="review-open-button" onClick={()=>setReviewPanelOpen(true)} aria-label="Visa detaljpanelen">← Visa detaljer</button>}<aside className="review" hidden={!reviewPanelOpen}><div className="review-heading"><div className="eyebrow">Granskning</div><button type="button" className="review-close-button" onClick={()=>setReviewPanelOpen(false)} aria-label="Dölj detaljpanelen" title="Dölj detaljpanelen">✕</button></div><div className="review-tabs" role="tablist" aria-label="Detaljpanel"><button role="tab" aria-selected={tab==="information"} className={tab==="information"?"active":""} onClick={()=>setTab("information")}>Information</button><button role="tab" aria-selected={tab==="comparison"} className={tab==="comparison"?"active":""} onClick={()=>setTab("comparison")}>Jämförelse</button><button role="tab" aria-selected={tab==="review"} className={tab==="review"?"active":""} onClick={()=>setTab("review")}>Bedömning</button></div>{tab==="information"&&<div><h2>{inspected==="stop"?"Hållplatsläge":inspected==="gkm"?"GKM-gånglänk":inspected==="otp"?"OTP-rutt":"Klicka på kartan"}</h2>{inspected==="stop"&&<>{detail("GID",pointInfo?.id)}{detail("Roll",pointInfo?.role)}<p className="hint">Namn, läge och giltighet kräver kompletterad export från GWS.</p></>}{(inspected==="gkm"||inspected==="otp")&&<>{detail("Från GID",selectedCase?.start_gid)}{detail("Till GID",selectedCase?.end_gid)}{Object.entries(selectedProperties??{}).filter(([key])=>key!=="case_id").map(([key,value])=><div key={key}>{detail(key,value)}</div>)}<p className="hint">Hastighet, tid och giltighet behöver tillföras från källdata.</p></>}</div>}{tab==="comparison"&&<div><h2>Jämförelse</h2>{detail("Från GID",selectedCase?.start_gid)}{detail("Till GID",selectedCase?.end_gid)}{detail("GKM",metricFormat(gkmValue))}{detail("OTP",metricFormat(otpValue))}{detail("Skillnad (OTP − GKM)",metricDifference===null?'Ej tillgängligt':(metricDifference>0?'+':'')+metricFormat(metricDifference<0?-metricDifference:metricDifference)+(metricDifference<0?(comparisonMode==='time'?' snabbare':' kortare'):'')+(metricDifference>0?(comparisonMode==='time'?' långsammare':' längre'):''))}{detail("Skillnad i procent",metricPercent===null?'Ej tillgängligt':(metricPercent>0?'+':'')+metricPercent.toLocaleString('sv-SE',{maximumFractionDigits:1})+' %')}<h3>Geometrisk överensstämmelse</h3>
{detail("Kvalitetskategori",qualityLabel(selectedCase?.quality_category))}
{detail("Symmetrisk linjetäckning",qualityPercent("symmetric_line_coverage_pct"))}
{detail("GKM nära OTP",qualityPercent("gkm_line_near_otp_pct"))}
{detail("OTP nära GKM",qualityPercent("otp_line_near_gkm_pct"))}
{detail("Hausdorffavstånd",qualityMeters("hausdorff_distance_m"))}
<p className="hint">Geometrisk överensstämmelse mäts med 5 meters tolerans. Låg överensstämmelse visar avvikande vägval, inte fel i GKM.</p>
{comparisonMode==='time'&&<p className="hint">Visar källornas rapporterade tider. Tiderna kan bygga på olika hastighetsmodeller.</p>}</div>}{tab==="review"&&<><h2>{selectedCase?.case_id??'Inget fall valt'}</h2>{selectedCase&&<><p>StopPoints: {selectedCase.start_gid} → {selectedCase.end_gid}</p><p>Skillnad OTP jämfört med GKM: <strong>{comparisonFor(selectedCase)}</strong>.</p><p className="hint">Kontrollera underlag, trappor, lutning, hinder och tillgänglighet. GKM:s ursprungliga motivering är inte dokumenterad.</p><label>Beslut<select value={review.decision} onChange={e=>update('decision',e.target.value)}><option value="">Välj bedömning</option>{decisions.map(d=><option key={d.value} value={d.value}>{d.label}</option>)}</select></label><label>Orsak<select value={review.reason} onChange={e=>update('reason',e.target.value)}>{reasons.map(r=><option key={r} value={r}>{r||'Välj orsak'}</option>)}</select></label><label>Kommentar<textarea rows={5} value={review.comment} onChange={e=>update('comment',e.target.value)} placeholder="Vad motiverar bedömningen?"/></label><label>Granskare<input value={review.reviewer} onChange={e=>update('reviewer',e.target.value)} placeholder="Namn"/></label><p className="hint">Bedömningar finns endast i den här öppna sidan tills de exporteras. Exportera innan du stänger eller laddar om.</p></>}</>}</aside></main></div></div>;
}


