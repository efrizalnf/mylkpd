<?php
// This file is part of Moodle - https://moodle.org/

namespace mod_mylkpd\privacy;

use core_privacy\local\metadata\collection;
use core_privacy\local\request\approved_contextlist;
use core_privacy\local\request\approved_userlist;
use core_privacy\local\request\contextlist;
use core_privacy\local\request\helper;
use core_privacy\local\request\transform;
use core_privacy\local\request\userlist;
use core_privacy\local\request\writer;

/**
 * Privacy API implementation for mod_mylkpd.
 *
 * @package    mod_mylkpd
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
class provider implements
        \core_privacy\local\metadata\provider,
        \core_privacy\local\request\plugin\provider,
        \core_privacy\local\request\core_userlist_provider {

    /**
     * Describes stored personal data.
     *
     * @param collection $collection
     * @return collection
     */
    public static function get_metadata(collection $collection): collection {
        $collection->add_database_table('mylkpd_submissions', [
            'userid' => 'privacy:metadata:mylkpd_submissions:userid',
            'answers' => 'privacy:metadata:mylkpd_submissions:answers',
            'grade' => 'privacy:metadata:mylkpd_submissions:grade',
            'feedback' => 'privacy:metadata:mylkpd_submissions:feedback',
            'timemodified' => 'privacy:metadata:mylkpd_submissions:timemodified',
        ], 'privacy:metadata:mylkpd_submissions');
        $collection->add_database_table('mylkpd_presence', [
            'userid' => 'privacy:metadata:mylkpd_presence:userid',
            'block' => 'privacy:metadata:mylkpd_presence:block',
            'timeseen' => 'privacy:metadata:mylkpd_presence:timeseen',
        ], 'privacy:metadata:mylkpd_presence');
        $collection->add_subsystem_link('core_grading', [], 'privacy:metadata:core_grading');
        return $collection;
    }

    /**
     * Contexts holding data for a user.
     *
     * @param int $userid
     * @return contextlist
     */
    public static function get_contexts_for_userid(int $userid): contextlist {
        $base = "SELECT c.id
                   FROM {context} c
                   JOIN {course_modules} cm ON cm.id = c.instanceid AND c.contextlevel = :ctxlevel
                   JOIN {modules} m ON m.id = cm.module AND m.name = 'mylkpd'
                   JOIN {mylkpd_submissions} s ON s.mylkpdid = cm.instance";
        $list = new contextlist();
        $list->add_from_sql("$base WHERE s.userid = :userid", ['ctxlevel' => CONTEXT_MODULE, 'userid' => $userid]);
        $list->add_from_sql("$base JOIN {groups_members} gm ON gm.groupid = s.groupid WHERE gm.userid = :userid",
            ['ctxlevel' => CONTEXT_MODULE, 'userid' => $userid]);
        $list->add_from_sql("$base JOIN {mylkpd_presence} p ON p.submissionid = s.id WHERE p.userid = :userid",
            ['ctxlevel' => CONTEXT_MODULE, 'userid' => $userid]);
        return $list;
    }

    /**
     * Users with data in a context.
     *
     * @param userlist $userlist
     */
    public static function get_users_in_context(userlist $userlist) {
        $context = $userlist->get_context();
        if (!$context instanceof \context_module) {
            return;
        }
        $sql = "SELECT s.userid
                  FROM {course_modules} cm
                  JOIN {modules} m ON m.id = cm.module AND m.name = 'mylkpd'
                  JOIN {mylkpd_submissions} s ON s.mylkpdid = cm.instance
                 WHERE cm.id = :cmid";
        $userlist->add_from_sql('userid', $sql, ['cmid' => $context->instanceid]);
        $sql = "SELECT p.userid
                  FROM {course_modules} cm
                  JOIN {modules} m ON m.id = cm.module AND m.name = 'mylkpd'
                  JOIN {mylkpd_submissions} s ON s.mylkpdid = cm.instance
                  JOIN {mylkpd_presence} p ON p.submissionid = s.id
                 WHERE cm.id = :cmid";
        $userlist->add_from_sql('userid', $sql, ['cmid' => $context->instanceid]);
    }

    /**
     * Exports a user's submissions.
     *
     * @param approved_contextlist $contextlist
     */
    public static function export_user_data(approved_contextlist $contextlist) {
        global $DB;
        $user = $contextlist->get_user();
        foreach ($contextlist->get_contexts() as $context) {
            if (!$context instanceof \context_module) {
                continue;
            }
            $cm = get_coursemodule_from_id('mylkpd', $context->instanceid);
            if (!$cm) {
                continue;
            }
            $sql = "SELECT s.*
                      FROM {mylkpd_submissions} s
                     WHERE s.mylkpdid = :mylkpdid
                       AND ((s.groupid = 0 AND s.userid = :userid)
                            OR s.groupid IN (SELECT groupid FROM {groups_members} WHERE userid = :userid2))";
            $subs = $DB->get_records_sql($sql, ['mylkpdid' => $cm->instance, 'userid' => $user->id,
                'userid2' => $user->id]);
            foreach ($subs as $sub) {
                $data = helper::get_context_data($context, $user);
                $data->groupwork = $sub->groupid ? transform::yesno(true) : transform::yesno(false);
                $data->answers = json_decode($sub->answers ?? '[]');
                $data->grade = $sub->grade;
                $data->feedback = $sub->feedback;
                $data->timemodified = transform::datetime($sub->timemodified);
                $path = [get_string('submissions', 'mod_mylkpd'), $sub->id];
                writer::with_context($context)->export_data($path, $data);
                \core_grading\privacy\provider::export_item_data($context, (int) $sub->id, $path);
            }
        }
    }

    /**
     * Deletes all submissions in a context.
     *
     * @param \context $context
     */
    public static function delete_data_for_all_users_in_context(\context $context) {
        global $DB;
        if (!$context instanceof \context_module) {
            return;
        }
        if ($cm = get_coursemodule_from_id('mylkpd', $context->instanceid)) {
            \core_grading\privacy\provider::delete_instance_data($context);
            $DB->delete_records_select('mylkpd_presence',
                'submissionid IN (SELECT id FROM {mylkpd_submissions} WHERE mylkpdid = ?)', [$cm->instance]);
            $DB->delete_records('mylkpd_submissions', ['mylkpdid' => $cm->instance]);
        }
    }

    /**
     * Deletes one user's submissions in the given contexts.
     *
     * @param approved_contextlist $contextlist
     */
    public static function delete_data_for_user(approved_contextlist $contextlist) {
        global $DB;
        $userid = $contextlist->get_user()->id;
        foreach ($contextlist->get_contexts() as $context) {
            if (!$context instanceof \context_module) {
                continue;
            }
            if ($cm = get_coursemodule_from_id('mylkpd', $context->instanceid)) {
                // Group work belongs to the whole group, so only the member's own data is removed.
                $DB->delete_records_select('mylkpd_presence',
                    'userid = ? AND submissionid IN (SELECT id FROM {mylkpd_submissions} WHERE mylkpdid = ?)',
                    [$userid, $cm->instance]);
                $own = $DB->get_records('mylkpd_submissions', ['mylkpdid' => $cm->instance, 'userid' => $userid,
                    'groupid' => 0], '', 'id');
                foreach ($own as $sub) {
                    \core_grading\privacy\provider::delete_instance_data($context, (int) $sub->id);
                }
                $DB->delete_records('mylkpd_submissions', ['mylkpdid' => $cm->instance, 'userid' => $userid,
                    'groupid' => 0]);
            }
        }
    }

    /**
     * Deletes submissions for several users in one context.
     *
     * @param approved_userlist $userlist
     */
    public static function delete_data_for_users(approved_userlist $userlist) {
        global $DB;
        $context = $userlist->get_context();
        if (!$context instanceof \context_module || !$userlist->get_userids()) {
            return;
        }
        if ($cm = get_coursemodule_from_id('mylkpd', $context->instanceid)) {
            [$insql, $params] = $DB->get_in_or_equal($userlist->get_userids(), SQL_PARAMS_NAMED);
            $params['mylkpdid'] = $cm->instance;
            $own = $DB->get_records_select('mylkpd_submissions', "mylkpdid = :mylkpdid AND groupid = 0 AND userid $insql",
                $params, '', 'id');
            foreach ($own as $sub) {
                \core_grading\privacy\provider::delete_instance_data($context, (int) $sub->id);
            }
            $DB->delete_records_select('mylkpd_submissions', "mylkpdid = :mylkpdid AND groupid = 0 AND userid $insql",
                $params);
            $DB->delete_records_select('mylkpd_presence', "userid $insql AND submissionid IN
                (SELECT id FROM {mylkpd_submissions} WHERE mylkpdid = :mylkpdid)", $params);
        }
    }
}
