-- sam_xml_import-g4w step 6: export what the repair script needs. Read-only.
-- Run whole in the SQL editor, copy the single `result` cell into a file (export.json), and run:
--   node tools/sam-tools/bin/repair-notation.js export.json <folder of source files>
-- Source files: the sam-scores bucket's <song id>.musicxml files (the path is in source_xml_path),
-- or the original files under their source_file names.
select json_build_object(
  'songs', (select coalesce(json_agg(t), '[]'::json) from (
    select s.id, s.title, s.source_file, s.source_xml_path,
      (select count(*) from public.sam_passes p where p.song_id = s.id) as passes,
      (select count(*) from public.sam_snippets x where x.song_id = s.id and not x.archived) as snippets,
      (select coalesce(json_agg(json_build_object(
          'number', m.number, 'source_measure', m.source_measure, 'rh', m.rh, 'lh', m.lh) order by m.number), '[]'::json)
        from public.sam_song_measures m where m.song_id = s.id) as measures,
      (select coalesce(json_agg(json_build_object(
          'id', f.id, 'measure_num', f.measure_num, 'rh_index', f.rh_index, 'note_index', f.note_index,
          'finger', f.finger, 'source', f.source)), '[]'::json)
        from public.sam_song_fingerings f where f.song_id = s.id) as fingerings,
      (select coalesce(json_agg(json_build_object(
          'id', l.id, 'measure_num', l.measure_num, 'rh_index', l.rh_index, 'syllable', l.syllable)), '[]'::json)
        from public.sam_song_lyrics l where l.song_id = s.id and l.measure_num is not null) as lyrics
    from public.sam_songs s
    where not s.archived and s.source_xml_path is not null
    order by s.title) t)
) as result;
