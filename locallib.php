<?php
// This file is part of Moodle - https://moodle.org/

/**
 * Internal helpers for mod_mylkpd.
 *
 * @package    mod_mylkpd
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

defined('MOODLE_INTERNAL') || die();

require_once(__DIR__ . '/lib.php');

/** PDF.js is bundled with the plugin (js/pdfjs), so no internet access is needed. */
define('MYLKPD_PDFJS_PATH', '/mod/mylkpd/js/pdfjs');
/** docx-preview + JSZip are bundled with the plugin (js/docx). */
define('MYLKPD_DOCX_PATH', '/mod/mylkpd/js/docx');
/** KaTeX (equations) is bundled with the plugin (js/katex). */
define('MYLKPD_KATEX_PATH', '/mod/mylkpd/js/katex');

/**
 * Pen colours students can choose from. The first one is the default.
 *
 * @return string[]
 */
function mylkpd_colors(): array {
    return ['#1a47b8', '#c62828', '#111111', '#2e7d32', '#f9a825'];
}

/**
 * Stores the display mode chosen for this activity.
 *
 * @param stdClass $mylkpd
 * @param string $mode pdf|docx
 */
function mylkpd_set_rendermode(stdClass $mylkpd, string $mode): void {
    global $DB;
    if (($mylkpd->rendermode ?? '') !== $mode) {
        $DB->set_field('mylkpd', 'rendermode', $mode, ['id' => $mylkpd->id]);
        $mylkpd->rendermode = $mode;
    }
}

/**
 * Finds how the worksheet should be shown.
 *
 * PDF files are shown as they are. Word/ODT files are converted to PDF when the site has a
 * document converter. When it has none, .docx files are rendered in the browser instead.
 * The choice is remembered per activity so answer positions never jump between modes.
 *
 * @param stdClass $mylkpd
 * @param context_module $context
 * @return array ['status' => ready|pending|failed|nofile, 'mode' => pdf|docx, 'file' => stored_file]
 */
function mylkpd_get_document(stdClass $mylkpd, context_module $context): array {
    $fs = get_file_storage();
    $files = $fs->get_area_files($context->id, 'mod_mylkpd', 'worksheet', 0, 'id', false);
    if (!$files) {
        return ['status' => 'nofile'];
    }
    $source = reset($files);
    $ext = core_text::strtolower(pathinfo($source->get_filename(), PATHINFO_EXTENSION));
    $isdocx = ($ext === 'docx');
    $mode = $mylkpd->rendermode ?? '';

    if (($mylkpd->workmode ?? '') === 'edit') {
        // Editing the text needs the real document structure, so always render the .docx itself.
        return $isdocx ? ['status' => 'ready', 'mode' => 'docx', 'file' => $source] : ['status' => 'editneedsdocx'];
    }
    if ($source->get_mimetype() === 'application/pdf' || $ext === 'pdf') {
        return ['status' => 'ready', 'mode' => 'pdf', 'file' => $source];
    }
    if ($mode === 'docx' && $isdocx) {
        return ['status' => 'ready', 'mode' => 'docx', 'file' => $source];
    }

    $pdfs = $fs->get_area_files($context->id, 'mod_mylkpd', 'pdf', 0, 'id', false);
    if ($pdfs) {
        mylkpd_set_rendermode($mylkpd, 'pdf');
        return ['status' => 'ready', 'mode' => 'pdf', 'file' => reset($pdfs)];
    }

    $status = 'failed';
    try {
        $converter = new \core_files\converter();
        if ($converter->can_convert_storedfile_to($source, 'pdf')) {
            $conversion = $converter->start_conversion($source, 'pdf');
            $state = (int) $conversion->get('status');
            if ($state === \core_files\conversion::STATUS_COMPLETE && ($dest = $conversion->get_destfile())) {
                $pdf = mylkpd_store_pdf($context, $dest);
                mylkpd_set_rendermode($mylkpd, 'pdf');
                return ['status' => 'ready', 'mode' => 'pdf', 'file' => $pdf];
            }
            $status = ($state === \core_files\conversion::STATUS_FAILED) ? 'failed' : 'pending';
        }
    } catch (\Throwable $e) {
        debugging('MyLKPD conversion error: ' . $e->getMessage(), DEBUG_DEVELOPER);
        $status = 'failed';
    }

    if ($isdocx) {
        // No (working) converter: show the Word file directly in the browser.
        mylkpd_set_rendermode($mylkpd, 'docx');
        return ['status' => 'ready', 'mode' => 'docx', 'file' => $source];
    }
    return ['status' => $status];
}

/**
 * Copies the converted PDF into the plugin's pdf file area (safe against concurrent requests).
 *
 * @param context_module $context
 * @param stored_file $source
 * @return stored_file
 */
function mylkpd_store_pdf(context_module $context, stored_file $source): stored_file {
    $fs = get_file_storage();
    $record = [
        'contextid' => $context->id,
        'component' => 'mod_mylkpd',
        'filearea' => 'pdf',
        'itemid' => 0,
        'filepath' => '/',
        'filename' => 'mylkpd.pdf',
    ];
    try {
        return $fs->create_file_from_storedfile($record, $source);
    } catch (stored_file_creation_exception $e) {
        return $fs->get_file($context->id, 'mod_mylkpd', 'pdf', 0, '/', 'mylkpd.pdf');
    }
}

/**
 * Validates one answer item sent by the browser.
 *
 * Coordinates are percentages of the page (0-100). Supported types:
 * text, check, cross (x, y), ellipse, highlight (x, y, w, h), line (x1, y1, x2, y2), pen (points).
 *
 * @param mixed $a
 * @return array|null clean item, or null when it should not be stored
 */
function mylkpd_clean_item($a): ?array {
    if (!is_array($a)) {
        return null;
    }
    $colors = mylkpd_colors();
    $pct = function($v): float {
        return min(100, max(0, round(is_numeric($v) ? (float) $v : 0, 2)));
    };
    $type = (string) ($a['type'] ?? '');
    $item = [
        'page' => max(1, min(1000, (int) ($a['page'] ?? 1))),
        'type' => $type,
        'color' => in_array($a['color'] ?? '', $colors, true) ? $a['color'] : $colors[0],
    ];
    switch ($type) {
        case 'text':
            $text = core_text::substr(clean_param((string) ($a['text'] ?? ''), PARAM_TEXT), 0, 5000);
            if (trim($text) === '') {
                return null;
            }
            $item += ['x' => $pct($a['x'] ?? 0), 'y' => $pct($a['y'] ?? 0), 'text' => $text];
            break;
        case 'check':
        case 'cross':
            $item += ['x' => $pct($a['x'] ?? 0), 'y' => $pct($a['y'] ?? 0)];
            break;
        case 'math':
            // LaTeX source. Only ever shown through KaTeX (trust off) or as plain text.
            $tex = trim(preg_replace('/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/u', '', (string) ($a['tex'] ?? '')));
            if ($tex === '' || core_text::strlen($tex) > 1000) {
                return null;
            }
            $item += ['x' => $pct($a['x'] ?? 0), 'y' => $pct($a['y'] ?? 0), 'tex' => $tex];
            break;
        case 'link':
            $url = clean_param(trim((string) ($a['url'] ?? '')), PARAM_URL);
            if (!preg_match('~^https?://~i', $url)) {
                return null;
            }
            $label = trim(core_text::substr(clean_param((string) ($a['text'] ?? ''), PARAM_TEXT), 0, 200));
            $item += ['x' => $pct($a['x'] ?? 0), 'y' => $pct($a['y'] ?? 0), 'text' => $label, 'url' => $url];
            break;
        case 'ellipse':
        case 'highlight':
            $item += ['x' => $pct($a['x'] ?? 0), 'y' => $pct($a['y'] ?? 0),
                'w' => $pct($a['w'] ?? 0), 'h' => $pct($a['h'] ?? 0)];
            if ($item['w'] <= 0 && $item['h'] <= 0) {
                return null;
            }
            break;
        case 'line':
            $item += ['x1' => $pct($a['x1'] ?? 0), 'y1' => $pct($a['y1'] ?? 0),
                'x2' => $pct($a['x2'] ?? 0), 'y2' => $pct($a['y2'] ?? 0)];
            break;
        case 'pen':
            $points = [];
            foreach (array_slice((array) ($a['points'] ?? []), 0, 3000) as $pt) {
                if (is_array($pt) && count($pt) >= 2) {
                    $points[] = [$pct($pt[0]), $pct($pt[1])];
                }
            }
            if (count($points) < 2) {
                return null;
            }
            $item['points'] = $points;
            break;
        default:
            return null;
    }
    if (in_array($type, ['ellipse', 'line', 'pen'], true)) {
        $width = (int) ($a['width'] ?? 4);
        $item['width'] = in_array($width, [2, 4, 8], true) ? $width : 4;
    }
    return $item;
}

/**
 * Reads the stored answers. Also understands the old format (a plain list of items).
 *
 * Stored format: {"items": {id: item+{v,by} | {deleted,v}}, "blocks": {paragraph: {html,v,by}}}
 *
 * @param string|null $json
 * @return array ['items' => array, 'blocks' => array]
 */
function mylkpd_decode_data(?string $json): array {
    $d = json_decode($json ?? '', true);
    if (!is_array($d)) {
        return ['items' => [], 'blocks' => []];
    }
    if (!array_key_exists('items', $d) && !array_key_exists('blocks', $d)) {
        $items = [];
        foreach (array_values($d) as $i => $old) {
            if ($clean = mylkpd_clean_item($old)) {
                $items['m' . $i] = $clean + ['v' => 0, 'by' => 0];
            }
        }
        return ['items' => $items, 'blocks' => []];
    }
    return [
        'items' => is_array($d['items'] ?? null) ? $d['items'] : [],
        'blocks' => is_array($d['blocks'] ?? null) ? $d['blocks'] : [],
    ];
}

/**
 * Data sent to the browser when a page is opened: live items (with id) and edited paragraphs.
 *
 * @param array $data from mylkpd_decode_data()
 * @return array ['items' => list, 'blocks' => map]
 */
function mylkpd_client_data(array $data): array {
    $items = [];
    foreach ($data['items'] as $id => $item) {
        if (empty($item['deleted'])) {
            $items[] = ['id' => (string) $id] + $item;
        }
    }
    $blocks = [];
    foreach ($data['blocks'] as $id => $block) {
        if (isset($block['html'])) {
            $blocks[(string) $id] = $block;
        }
    }
    return ['items' => $items, 'blocks' => (object) $blocks];
}

/**
 * The user's group for this activity (first group in the activity's grouping), or 0.
 *
 * @param cm_info|stdClass $cm
 * @param int $userid
 * @return int
 */
function mylkpd_get_user_groupid($cm, int $userid): int {
    $groups = groups_get_all_groups($cm->course, $userid, $cm->groupingid, 'g.id');
    return $groups ? (int) reset($groups)->id : 0;
}

/**
 * Finds (and optionally creates) the submission a user works on: their own, or their group's.
 *
 * @param stdClass $mylkpd
 * @param cm_info|stdClass $cm
 * @param int $userid
 * @param bool $create
 * @return stdClass|null null in group mode when the user has no group
 */
function mylkpd_find_submission(stdClass $mylkpd, $cm, int $userid, bool $create = false): ?stdClass {
    global $DB;
    if (!empty($mylkpd->teamsubmission)) {
        $groupid = mylkpd_get_user_groupid($cm, $userid);
        if (!$groupid) {
            return null;
        }
        $params = ['mylkpdid' => $mylkpd->id, 'groupid' => $groupid];
    } else {
        $params = ['mylkpdid' => $mylkpd->id, 'userid' => $userid, 'groupid' => 0];
    }
    $sub = $DB->get_record('mylkpd_submissions', $params);
    if (!$sub && $create) {
        $now = time();
        $sub = (object) ($params + [
            'userid' => $userid,
            'answers' => '{"items":{},"blocks":{}}',
            'status' => MYLKPD_STATUS_DRAFT,
            'revision' => 0,
            'timecreated' => $now,
            'timemodified' => $now,
            'timegraded' => 0,
        ]);
        $sub->id = $DB->insert_record('mylkpd_submissions', $sub);
    }
    return $sub ?: null;
}

/**
 * Saves changes from one browser and returns everything that changed since $sincerev.
 *
 * Every item and paragraph carries the revision of its last change ("v"), so each browser only
 * receives what is new to it. Writes are serialised with a Moodle lock per submission.
 *
 * @param stdClass $mylkpd
 * @param cm_info|stdClass $cm
 * @param int $userid
 * @param int $sincerev
 * @param array $ops list of ['op' => put|del, 'kind' => item|block, 'id' => string, ...]
 * @param string $block paragraph the user is editing now ('' if none)
 * @return array
 */
function mylkpd_sync(stdClass $mylkpd, $cm, int $userid, int $sincerev, array $ops, string $block): array {
    global $DB;

    $key = $mylkpd->teamsubmission ? 'g' . mylkpd_get_user_groupid($cm, $userid) : 'u' . $userid;
    if ($key === 'g0') {
        throw new moodle_exception('nogroup', 'mod_mylkpd');
    }
    $lock = \core\lock\lock_config::get_lock_factory('mod_mylkpd_sync')
        ->get_lock('sub_' . $mylkpd->id . '_' . $key, 10);
    if (!$lock) {
        throw new moodle_exception('locktimeout', 'mod_mylkpd');
    }

    try {
        $sub = mylkpd_find_submission($mylkpd, $cm, $userid, true);
        $data = mylkpd_decode_data($sub->answers);
        $changed = false;

        if ($ops && $sub->status != MYLKPD_STATUS_SUBMITTED) {
            $live = count(array_filter($data['items'], function($i) {
                return empty($i['deleted']);
            }));
            foreach (array_slice($ops, 0, 500) as $op) {
                if (!is_array($op)) {
                    continue;
                }
                $id = clean_param((string) ($op['id'] ?? ''), PARAM_ALPHANUMEXT);
                if ($id === '' || strlen($id) > 40) {
                    continue;
                }
                $kind = $op['kind'] ?? '';
                $action = $op['op'] ?? '';

                if ($kind === 'item' && $action === 'put') {
                    $item = mylkpd_clean_item($op['data'] ?? null);
                    $isnew = !isset($data['items'][$id]) || !empty($data['items'][$id]['deleted']);
                    if (!$item || ($isnew && $live >= 2000)) {
                        continue;
                    }
                    $live += $isnew ? 1 : 0;
                    $data['items'][$id] = $item + ['v' => ++$sub->revision, 'by' => $userid];
                    $changed = true;
                } else if ($kind === 'item' && $action === 'del') {
                    if (isset($data['items'][$id]) && empty($data['items'][$id]['deleted'])) {
                        $data['items'][$id] = ['deleted' => 1, 'v' => ++$sub->revision];
                        $live--;
                        $changed = true;
                    }
                } else if ($kind === 'block' && $action === 'put' && ctype_digit($id) && (int) $id < 100000) {
                    $html = purify_html(core_text::substr((string) ($op['html'] ?? ''), 0, 20000));
                    $data['blocks'][$id] = ['html' => $html, 'v' => ++$sub->revision, 'by' => $userid];
                    $changed = true;
                }
            }
        }

        if ($changed) {
            $sub->answers = json_encode($data, JSON_UNESCAPED_UNICODE);
            $sub->timemodified = time();
            $DB->update_record('mylkpd_submissions', $sub);
        }
    } finally {
        $lock->release();
    }

    $presence = [];
    if ($mylkpd->teamsubmission) {
        $now = time();
        $block = ctype_digit($block) ? $block : '';
        $mine = $DB->get_record('mylkpd_presence', ['submissionid' => $sub->id, 'userid' => $userid]);
        if (!$mine) {
            $DB->insert_record('mylkpd_presence', (object) ['submissionid' => $sub->id, 'userid' => $userid,
                'block' => $block, 'timeseen' => $now]);
        } else if ((string) $mine->block !== $block || $now - $mine->timeseen >= 10) {
            $DB->update_record('mylkpd_presence', (object) ['id' => $mine->id, 'block' => $block, 'timeseen' => $now]);
        }
        $rows = $DB->get_records_select('mylkpd_presence', 'submissionid = ? AND timeseen > ?', [$sub->id, $now - 40]);
        foreach ($rows as $row) {
            $presence[] = ['userid' => (int) $row->userid, 'block' => (string) $row->block,
                'ago' => $row->userid == $userid ? 0 : max(0, $now - $row->timeseen)];
        }
    }

    $items = [];
    foreach ($data['items'] as $id => $item) {
        if (($item['v'] ?? 0) > $sincerev) {
            $items[(string) $id] = $item;
        }
    }
    $blocks = [];
    foreach ($data['blocks'] as $id => $b) {
        if (($b['v'] ?? 0) > $sincerev) {
            $blocks[(string) $id] = $b;
        }
    }
    return [
        'rev' => (int) $sub->revision,
        'status' => (int) $sub->status,
        'items' => (object) $items,
        'blocks' => (object) $blocks,
        'presence' => $presence,
    ];
}

/**
 * Members shown in the editor (names and a colour each).
 *
 * @param int[] $userids
 * @return array userid => ['name' => string, 'color' => string]
 */
function mylkpd_members(array $userids): array {
    global $DB;
    $palette = ['#e91e63', '#3f51b5', '#009688', '#ff9800', '#795548', '#9c27b0', '#00acc1', '#7cb342'];
    $out = [];
    if (!$userids) {
        return $out;
    }
    $users = $DB->get_records_list('user', 'id', $userids);
    $i = 0;
    foreach ($userids as $uid) {
        if (isset($users[$uid])) {
            $out[$uid] = ['name' => fullname($users[$uid]), 'color' => $palette[$i++ % count($palette)]];
        }
    }
    return $out;
}

/**
 * Members of the group or person a submission belongs to.
 *
 * @param stdClass $mylkpd
 * @param int $groupid
 * @param int $userid
 * @return int[]
 */
function mylkpd_member_ids(stdClass $mylkpd, int $groupid, int $userid): array {
    if ($mylkpd->teamsubmission && $groupid) {
        return array_map('intval', array_keys(groups_get_members($groupid, 'u.id', 'u.lastname, u.firstname')));
    }
    return $userid ? [$userid] : [];
}

/**
 * Counts what each member last changed, for the teacher.
 *
 * @param array $data from mylkpd_decode_data()
 * @return array userid => ['items' => int, 'blocks' => int]
 */
function mylkpd_contributions(array $data): array {
    $out = [];
    foreach ($data['items'] as $item) {
        if (empty($item['deleted']) && !empty($item['by'])) {
            $out[$item['by']]['items'] = ($out[$item['by']]['items'] ?? 0) + 1;
        }
    }
    foreach ($data['blocks'] as $b) {
        if (!empty($b['by'])) {
            $out[$b['by']]['blocks'] = ($out[$b['by']]['blocks'] ?? 0) + 1;
        }
    }
    return $out;
}

/**
 * Whether students may reopen (edit again) a submitted worksheet.
 *
 * @param stdClass $mylkpd
 * @param stdClass|null $submission
 * @return bool
 */
function mylkpd_can_reopen(stdClass $mylkpd, ?stdClass $submission): bool {
    if (!$submission || $submission->status != MYLKPD_STATUS_SUBMITTED) {
        return false;
    }
    $mode = (int) ($mylkpd->allowresubmit ?? 1);
    if ($mode === 2) {
        return true;
    }
    // "Until graded" means until a real grade is saved; feedback alone does not lock the work.
    return $mode === 1 && ($submission->grade === null || $submission->grade === '');
}

/**
 * The active advanced grading controller (rubric, marking guide), if the teacher set one up.
 *
 * @param stdClass $mylkpd
 * @param context_module $context
 * @return gradingform_controller|null
 */
function mylkpd_grading_controller(stdClass $mylkpd, context_module $context) {
    global $CFG;
    if ($mylkpd->grade == 0) {
        return null;
    }
    require_once($CFG->dirroot . '/grade/grading/lib.php');
    $manager = get_grading_manager($context, 'mod_mylkpd', 'submissions');
    if (!$method = $manager->get_active_method()) {
        return null;
    }
    $controller = $manager->get_controller($method);
    $controller->set_grade_range(make_grades_menu($mylkpd->grade), $mylkpd->grade > 0);
    return $controller;
}

/**
 * Link to Moodle's page where the teacher chooses and builds the rubric.
 *
 * @param context_module $context
 * @return moodle_url
 */
function mylkpd_grading_manage_url(context_module $context): moodle_url {
    return new moodle_url('/grade/grading/manage.php',
        ['contextid' => $context->id, 'component' => 'mod_mylkpd', 'area' => 'submissions']);
}

/**
 * Formats a grade for display.
 *
 * @param stdClass $mylkpd
 * @param float|null $grade
 * @return string
 */
function mylkpd_display_grade(stdClass $mylkpd, $grade): string {
    if ($grade === null || $mylkpd->grade == 0) {
        return '-';
    }
    if ($mylkpd->grade < 0) {
        $menu = make_grades_menu($mylkpd->grade);
        return $menu[(int) $grade] ?? '-';
    }
    return format_float($grade, 2) . ' / ' . $mylkpd->grade;
}

/**
 * Toolbar button.
 *
 * @param string $attr data attribute name (without data-mylkpd-)
 * @param string $value
 * @param string $icon HTML
 * @param string $label
 * @param bool $showlabel
 * @param bool $active
 * @return string
 */
function mylkpd_toolbar_button(string $attr, string $value, string $icon, string $label, bool $showlabel = true,
        bool $active = false): string {
    $attrs = [
        'type' => 'button',
        'class' => 'btn btn-sm ' . ($active ? 'btn-primary' : 'btn-outline-secondary'),
        'data-mylkpd-' . $attr => $value,
        'title' => $label,
        'aria-label' => $label,
    ];
    if ($attr === 'tool') {
        $attrs['aria-pressed'] = $active ? 'true' : 'false';
    }
    $content = html_writer::span($icon, 'mylkpd-icon', ['aria-hidden' => 'true']);
    if ($showlabel) {
        $content .= html_writer::span($label, 'mylkpd-tool-label');
    }
    return html_writer::tag('button', $content, $attrs);
}

/**
 * Builds the editing toolbar (inspired by CKEditor): one sticky panel with grouped tools.
 *
 * Row 1: tools (type, move, draw...) | undo/redo.
 * Row 2: text formatting (docx) | colour and thickness | inserts | help.
 * Then a message line and, for group work, who is online.
 *
 * @param bool $cantype whether the document is a .docx shown in the browser (typing in paragraphs possible)
 * @param string $defaulttool
 * @param string $teambar HTML for group work (presence and names toggle), or ''
 * @return string HTML
 */
function mylkpd_render_toolbar(bool $cantype, string $defaulttool, string $teambar = ''): string {
    $s = function($key) {
        return get_string($key, 'mod_mylkpd');
    };
    $group = function(string $content, string $label, string $extra = '') {
        return html_writer::div($content, trim('mylkpd-group ' . $extra), ['role' => 'group', 'aria-label' => $label]);
    };
    $html = html_writer::start_div('mylkpd-toolbar', ['role' => 'toolbar', 'aria-label' => $s('toolbar')]);

    // Row 1.
    $tools = [];
    if ($cantype) {
        $tools['type'] = '&#9000;';
    }
    $tools += ['move' => '&#10021;', 'text' => 'T', 'check' => '&#10003;', 'cross' => '&#10007;',
        'circle' => '&#9711;', 'highlight' => '&#9644;', 'line' => '&#9585;', 'pen' => '&#9998;', 'erase' => '&#9003;'];
    $buttons = '';
    foreach ($tools as $tool => $icon) {
        $buttons .= mylkpd_toolbar_button('tool', $tool, $icon, $s('tool' . $tool), true, $tool === $defaulttool);
    }
    $row1 = $group($buttons, $s('tools'), 'mylkpd-tools');

    $names = ['colorblue', 'colorred', 'colorblack', 'colorgreen', 'coloryellow'];
    $style = '';
    foreach (mylkpd_colors() as $i => $color) {
        $label = $s($names[$i]);
        $style .= html_writer::tag('button', '', [
            'type' => 'button',
            'class' => 'mylkpd-swatch' . ($i === 0 ? ' active' : ''),
            'style' => 'background-color:' . $color,
            'data-mylkpd-color' => $color,
            'aria-pressed' => $i === 0 ? 'true' : 'false',
            'aria-label' => $label,
            'title' => $label,
        ]);
    }
    $style .= html_writer::select([2 => $s('widththin'), 4 => $s('widthmedium'), 8 => $s('widththick')],
        'mylkpdwidth', 4, false, [
            'class' => 'custom-select form-select form-select-sm mylkpd-width',
            'data-mylkpd-width' => '1',
            'aria-label' => $s('width'),
            'title' => $s('width'),
        ]);
    $row1 .= $group(
        mylkpd_toolbar_button('action', 'undo', '&#8630;', $s('undo') . ' (Ctrl+Z)', false) .
        mylkpd_toolbar_button('action', 'redo', '&#8631;', $s('redo') . ' (Ctrl+Y)', false),
        $s('history'), 'mylkpd-history');
    $html .= html_writer::div($row1, 'mylkpd-row');

    // Row 2.
    $row2 = '';
    if ($cantype) {
        $formats = [
            'bold' => '<b>B</b>', 'italic' => '<i>I</i>', 'underline' => '<u>U</u>', 'strikeThrough' => '<s>S</s>',
            'superscript' => 'x&sup2;', 'subscript' => 'x&#8322;',
            'foreColor' => '<span class="mylkpd-a-color">A</span>', 'hiliteColor' => '<span class="mylkpd-a-mark">ab</span>',
            'removeFormat' => '&#10008;<small>T</small>',
        ];
        $buttons = '';
        foreach ($formats as $cmd => $icon) {
            $buttons .= mylkpd_toolbar_button('format', $cmd, $icon, $s('format' . strtolower($cmd)), false);
        }
        $row2 .= $group($buttons, $s('formatting'), 'mylkpd-formatgroup');
    }
    $row2 .= $group($style, $s('color'), 'mylkpd-style');
    $buttons = '';
    foreach (['math' => '&#8721;', 'symbol' => '&#937;', 'arabic' => '&#1593;', 'link' => '&#128279;'] as $what => $icon) {
        $buttons .= mylkpd_toolbar_button('insert', $what, $icon, $s('insert' . $what));
    }
    $row2 .= $group($buttons, $s('insert'), 'mylkpd-inserts');
    $row2 .= html_writer::tag('details',
        html_writer::tag('summary', '&#9432; ' . $s('help'), ['class' => 'btn btn-sm btn-link']) .
        html_writer::div($s($cantype ? 'toolhinttype' : 'toolhint'), 'mylkpd-help-text small'),
        ['class' => 'mylkpd-help']);
    $html .= html_writer::div($row2, 'mylkpd-row');

    // Messages (where to click, what to do next).
    $html .= html_writer::div('', 'mylkpd-hint small', ['data-mylkpd-hint' => 1, 'role' => 'status', 'aria-live' => 'polite']);
    if ($teambar !== '') {
        $html .= html_writer::div($teambar, 'mylkpd-row mylkpd-teamrow');
    }
    $html .= html_writer::end_div();
    return $html;
}

/**
 * Status badge for a submission.
 *
 * @param stdClass|null $sub
 * @return string
 */
function mylkpd_status_badge(?stdClass $sub): string {
    if (!$sub) {
        return html_writer::span(get_string('statusnotstarted', 'mod_mylkpd'), 'badge bg-light text-dark');
    }
    if ($sub->status == MYLKPD_STATUS_SUBMITTED) {
        return html_writer::span(get_string('statussubmitted', 'mod_mylkpd'), 'badge bg-success');
    }
    return html_writer::span(get_string('statusdraft', 'mod_mylkpd'), 'badge bg-warning text-dark');
}

/**
 * Builds the worksheet viewer/editor and loads its JavaScript.
 *
 * @param stdClass $mylkpd
 * @param cm_info|stdClass $cm
 * @param context_module $context
 * @param stdClass|null $submission the submission to show (null = empty worksheet)
 * @param bool $readonly
 * @param int[] $memberids people shown with names/colours (group members)
 * @return array ['html' => string, 'ready' => bool]
 */
function mylkpd_render_worksheet(stdClass $mylkpd, $cm, context_module $context, ?stdClass $submission,
        bool $readonly, array $memberids = []): array {
    global $PAGE, $OUTPUT, $USER;

    $doc = mylkpd_get_document($mylkpd, $context);
    if ($doc['status'] !== 'ready') {
        $type = $doc['status'] === 'pending' ? \core\output\notification::NOTIFY_INFO
            : \core\output\notification::NOTIFY_ERROR;
        $key = $doc['status'] === 'editneedsdocx' ? 'editneedsdocx' : 'pdf' . $doc['status'];
        return ['html' => $OUTPUT->notification(get_string($key, 'mod_mylkpd'), $type), 'ready' => false];
    }

    $file = $doc['file'];
    $docurl = moodle_url::make_pluginfile_url($context->id, 'mod_mylkpd', $file->get_filearea(),
        $file->get_itemid(), $file->get_filepath(), $file->get_filename());
    $workmode = ($mylkpd->workmode ?? '') === 'edit' ? 'edit' : 'annotate';
    // A .docx shown in the browser can always be typed into, alongside the drawing tools.
    $cantype = $doc['mode'] === 'docx';
    $defaulttool = ($cantype && $workmode === 'edit') ? 'type' : 'text';
    $data = mylkpd_client_data(mylkpd_decode_data($submission->answers ?? null));
    $team = !empty($mylkpd->teamsubmission);

    $config = [
        'containerId' => 'mylkpd-container',
        'mode' => $doc['mode'],
        'workmode' => $workmode,
        'docUrl' => $docurl->out(false),
        'pdfjsBase' => (new moodle_url(MYLKPD_PDFJS_PATH))->out(false),
        'workerUrl' => (new moodle_url(MYLKPD_PDFJS_PATH . '/pdf.worker.min.js'))->out(false),
        'docxBase' => (new moodle_url(MYLKPD_DOCX_PATH))->out(false),
        'katexBase' => (new moodle_url(MYLKPD_KATEX_PATH))->out(false),
        'canType' => $cantype,
        'defaultTool' => $defaulttool,
        'syncUrl' => (new moodle_url('/mod/mylkpd/ajax.php'))->out(false),
        'cmid' => (int) $cm->id,
        'sesskey' => sesskey(),
        'userid' => (int) $USER->id,
        'rev' => (int) ($submission->revision ?? 0),
        'collab' => $team && !$readonly,
        'showNames' => $team,
        'colors' => mylkpd_colors(),
        'items' => $data['items'],
        'blocks' => $data['blocks'],
        'members' => (object) mylkpd_members($memberids),
        'readonly' => $readonly,
        'strings' => [
            'answer' => get_string('answer', 'mod_mylkpd'),
            'check' => get_string('toolcheck', 'mod_mylkpd'),
            'cross' => get_string('toolcross', 'mod_mylkpd'),
            'confirmsubmit' => get_string($team ? 'confirmsubmitgroup' : 'confirmsubmit', 'mod_mylkpd'),
            'loaderror' => get_string('loaderror', 'mod_mylkpd'),
            'saving' => get_string('saving', 'mod_mylkpd'),
            'saved' => get_string('saved', 'mod_mylkpd'),
            'savedat' => get_string('savedat', 'mod_mylkpd', '{time}'),
            'saveerror' => get_string('saveerror', 'mod_mylkpd'),
            'online' => get_string('online', 'mod_mylkpd'),
            'editing' => get_string('editing', 'mod_mylkpd', '{name}'),
            'editedby' => get_string('editedby', 'mod_mylkpd', '{name}'),
            'you' => get_string('you', 'mod_mylkpd'),
            'insert' => get_string('insertbutton', 'mod_mylkpd'),
            'cancel' => get_string('cancel'),
            'close' => get_string('closebuttontitle'),
            'mathtitle' => get_string('insertmath', 'mod_mylkpd'),
            'mathhint' => get_string('mathhint', 'mod_mylkpd'),
            'mathpreview' => get_string('mathpreview', 'mod_mylkpd'),
            'linktitle' => get_string('insertlink', 'mod_mylkpd'),
            'linktext' => get_string('linktext', 'mod_mylkpd'),
            'linkurl' => get_string('linkurl', 'mod_mylkpd'),
            'linkinvalid' => get_string('linkinvalid', 'mod_mylkpd'),
            'symboltitle' => get_string('insertsymbol', 'mod_mylkpd'),
            'arabictitle' => get_string('insertarabic', 'mod_mylkpd'),
            'space' => get_string('arabicspace', 'mod_mylkpd'),
            'backspace' => get_string('arabicbackspace', 'mod_mylkpd'),
            'clicktoplace' => get_string('clicktoplace', 'mod_mylkpd'),
            'needfocus' => get_string('needfocus', 'mod_mylkpd'),
        ],
    ];

    $PAGE->requires->js(new moodle_url('/mod/mylkpd/js/worksheet.js'));
    $PAGE->requires->js_init_code('MyLKPD.init(' . json_encode($config) . ');', true);

    $html = '';
    $toggle = '';
    if ($team) {
        $toggle = html_writer::tag('label',
            html_writer::empty_tag('input', ['type' => 'checkbox', 'checked' => 'checked', 'data-mylkpd-names' => 1,
                'class' => 'form-check-input me-1 mr-1']) . get_string('shownames', 'mod_mylkpd'),
            ['class' => 'mylkpd-namestoggle small']);
    }
    if (!$readonly) {
        $teambar = $team ? html_writer::div('', 'mylkpd-presence', ['id' => 'mylkpd-presence', 'aria-live' => 'polite']) . $toggle : '';
        $html .= mylkpd_render_toolbar($cantype, $defaulttool, $teambar);
    } else if ($team) {
        $html .= html_writer::div($toggle, 'mylkpd-teambar');
    }
    $classes = 'mylkpd-container' . ($cantype ? ' mylkpd-work-edit' : '') . ' mylkpd-mode-' . ($readonly ? 'view' : $defaulttool);
    $html .= html_writer::div('', $classes, ['id' => 'mylkpd-container']);

    return ['html' => $html, 'ready' => true];
}
