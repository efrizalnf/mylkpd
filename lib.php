<?php
// This file is part of Moodle - https://moodle.org/

/**
 * Core API callbacks for mod_mylkpd.
 *
 * @package    mod_mylkpd
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

defined('MOODLE_INTERNAL') || die();

/** Submission is still being worked on by the student. */
define('MYLKPD_STATUS_DRAFT', 0);
/** Submission has been handed in and is locked. */
define('MYLKPD_STATUS_SUBMITTED', 1);

/**
 * Features supported by this module.
 *
 * @param string $feature FEATURE_xx constant
 * @return mixed
 */
function mylkpd_supports($feature) {
    switch ($feature) {
        case FEATURE_MOD_INTRO:
        case FEATURE_SHOW_DESCRIPTION:
        case FEATURE_GRADE_HAS_GRADE:
        case FEATURE_COMPLETION_TRACKS_VIEWS:
        case FEATURE_GROUPS:
        case FEATURE_GROUPINGS:
            return true;
        case FEATURE_BACKUP_MOODLE2:
            return false;
        case FEATURE_MOD_PURPOSE:
            return MOD_PURPOSE_ASSESSMENT;
        default:
            return null;
    }
}

/**
 * File manager options for the worksheet upload.
 *
 * @return array
 */
function mylkpd_filemanager_options(): array {
    return [
        'subdirs' => 0,
        'maxfiles' => 1,
        'accepted_types' => ['.pdf', '.doc', '.docx', '.odt'],
    ];
}

/**
 * Returns an identifier for the current worksheet file, used to detect a new upload.
 *
 * @param context $context
 * @return string
 */
function mylkpd_worksheet_hash(context $context): string {
    $files = get_file_storage()->get_area_files($context->id, 'mod_mylkpd', 'worksheet', 0, 'id', false);
    if (!$files) {
        return '';
    }
    $file = reset($files);
    return $file->get_contenthash() . '/' . $file->get_filename();
}

/**
 * Saves the uploaded worksheet. When the file changed, the cached PDF and display mode are reset.
 *
 * @param stdClass $data Form data
 */
function mylkpd_save_worksheet(stdClass $data): void {
    global $DB;
    $context = context_module::instance($data->coursemodule);
    $before = mylkpd_worksheet_hash($context);
    file_save_draft_area_files($data->worksheet, $context->id, 'mod_mylkpd', 'worksheet', 0,
        mylkpd_filemanager_options());
    if (mylkpd_worksheet_hash($context) !== $before) {
        get_file_storage()->delete_area_files($context->id, 'mod_mylkpd', 'pdf');
        $DB->set_field('mylkpd', 'rendermode', null, ['id' => $data->id]);
    }
}

/**
 * Adds a new instance.
 *
 * @param stdClass $data
 * @param mod_mylkpd_mod_form|null $mform
 * @return int new instance id
 */
function mylkpd_add_instance($data, $mform = null) {
    global $DB;
    $data->timecreated = time();
    $data->timemodified = $data->timecreated;
    $data->id = $DB->insert_record('mylkpd', $data);
    mylkpd_save_worksheet($data);
    mylkpd_grade_item_update($data);
    return $data->id;
}

/**
 * Updates an instance.
 *
 * @param stdClass $data
 * @param mod_mylkpd_mod_form|null $mform
 * @return bool
 */
function mylkpd_update_instance($data, $mform = null) {
    global $DB;
    $data->id = $data->instance;
    $data->timemodified = time();
    $DB->update_record('mylkpd', $data);
    mylkpd_save_worksheet($data);
    mylkpd_grade_item_update($data);
    mylkpd_update_grades($data);
    return true;
}

/**
 * Deletes an instance and its submissions. Files are removed with the context.
 *
 * @param int $id
 * @return bool
 */
function mylkpd_delete_instance($id) {
    global $DB;
    if (!$mylkpd = $DB->get_record('mylkpd', ['id' => $id])) {
        return false;
    }
    $DB->delete_records_select('mylkpd_presence',
        'submissionid IN (SELECT id FROM {mylkpd_submissions} WHERE mylkpdid = ?)', [$mylkpd->id]);
    $DB->delete_records('mylkpd_submissions', ['mylkpdid' => $mylkpd->id]);
    $DB->delete_records('mylkpd', ['id' => $mylkpd->id]);
    mylkpd_grade_item_delete($mylkpd);
    return true;
}

/**
 * Creates or updates the gradebook item, optionally pushing grades.
 *
 * @param stdClass $mylkpd
 * @param array|string|null $grades
 * @return int GRADE_UPDATE_xx
 */
function mylkpd_grade_item_update($mylkpd, $grades = null) {
    global $CFG;
    require_once($CFG->libdir . '/gradelib.php');

    $params = ['itemname' => $mylkpd->name];
    if (isset($mylkpd->cmidnumber)) {
        $params['idnumber'] = $mylkpd->cmidnumber;
    }
    if ($mylkpd->grade > 0) {
        $params['gradetype'] = GRADE_TYPE_VALUE;
        $params['grademax'] = $mylkpd->grade;
        $params['grademin'] = 0;
    } else if ($mylkpd->grade < 0) {
        $params['gradetype'] = GRADE_TYPE_SCALE;
        $params['scaleid'] = -$mylkpd->grade;
    } else {
        $params['gradetype'] = GRADE_TYPE_NONE;
    }
    if ($grades === 'reset') {
        $params['reset'] = true;
        $grades = null;
    }
    return grade_update('mod/mylkpd', $mylkpd->course, 'mod', 'mylkpd', $mylkpd->id, 0, $grades, $params);
}

/**
 * Removes the gradebook item.
 *
 * @param stdClass $mylkpd
 * @return int
 */
function mylkpd_grade_item_delete($mylkpd) {
    global $CFG;
    require_once($CFG->libdir . '/gradelib.php');
    return grade_update('mod/mylkpd', $mylkpd->course, 'mod', 'mylkpd', $mylkpd->id, 0, null, ['deleted' => 1]);
}

/**
 * Pushes grades from submissions to the gradebook. A group grade goes to every group member.
 *
 * @param stdClass $mylkpd
 * @param int $userid 0 for all users
 * @param bool $nullifnone
 */
function mylkpd_update_grades($mylkpd, $userid = 0, $nullifnone = true) {
    global $CFG, $DB;
    require_once($CFG->libdir . '/grouplib.php');
    $grades = [];
    foreach ($DB->get_records('mylkpd_submissions', ['mylkpdid' => $mylkpd->id]) as $sub) {
        $users = $sub->groupid ? array_keys(groups_get_members($sub->groupid, 'u.id')) : [$sub->userid];
        foreach ($users as $uid) {
            if (!$uid || ($userid && $uid != $userid)) {
                continue;
            }
            $grades[$uid] = (object) [
                'userid' => $uid,
                'rawgrade' => $sub->grade,
                'feedback' => $sub->feedback,
                'feedbackformat' => FORMAT_PLAIN,
                'dategraded' => $sub->timegraded ?: null,
            ];
        }
    }
    mylkpd_grade_item_update($mylkpd, $grades ?: null);
}

/**
 * Serves the worksheet files.
 *
 * @param stdClass $course
 * @param stdClass $cm
 * @param context $context
 * @param string $filearea
 * @param array $args
 * @param bool $forcedownload
 * @param array $options
 * @return bool false if the file was not found
 */
function mylkpd_pluginfile($course, $cm, $context, $filearea, $args, $forcedownload, array $options = []) {
    if ($context->contextlevel != CONTEXT_MODULE) {
        return false;
    }
    if (!in_array($filearea, ['worksheet', 'pdf'])) {
        return false;
    }
    require_login($course, true, $cm);
    require_capability('mod/mylkpd:view', $context);

    $itemid = (int) array_shift($args);
    $filename = array_pop($args);
    $filepath = $args ? '/' . implode('/', $args) . '/' : '/';

    $file = get_file_storage()->get_file($context->id, 'mod_mylkpd', $filearea, $itemid, $filepath, $filename);
    if (!$file || $file->is_directory()) {
        return false;
    }
    send_stored_file($file, 0, 0, $forcedownload, $options);
}
