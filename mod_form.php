<?php
// This file is part of Moodle - https://moodle.org/

/**
 * Activity settings form.
 *
 * @package    mod_mylkpd
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

defined('MOODLE_INTERNAL') || die();

require_once($CFG->dirroot . '/course/moodleform_mod.php');
require_once($CFG->dirroot . '/mod/mylkpd/lib.php');

/**
 * Settings form for mod_mylkpd.
 */
class mod_mylkpd_mod_form extends moodleform_mod {

    /**
     * Form definition.
     */
    public function definition() {
        $mform = $this->_form;

        $mform->addElement('header', 'general', get_string('general', 'form'));
        $mform->addElement('text', 'name', get_string('name'), ['size' => '64']);
        $mform->setType('name', PARAM_TEXT);
        $mform->addRule('name', null, 'required', null, 'client');
        $mform->addRule('name', get_string('maximumchars', '', 255), 'maxlength', 255, 'client');

        $this->standard_intro_elements();

        $mform->addElement('filemanager', 'worksheet', get_string('worksheetfile', 'mod_mylkpd'), null,
            mylkpd_filemanager_options());
        $mform->addRule('worksheet', null, 'required');
        $mform->addHelpButton('worksheet', 'worksheetfile', 'mod_mylkpd');

        $mform->addElement('select', 'workmode', get_string('workmode', 'mod_mylkpd'), [
            'annotate' => get_string('workmodeannotate', 'mod_mylkpd'),
            'edit' => get_string('workmodeedit', 'mod_mylkpd'),
        ]);
        $mform->setDefault('workmode', 'annotate');
        $mform->addHelpButton('workmode', 'workmode', 'mod_mylkpd');

        $mform->addElement('advcheckbox', 'teamsubmission', get_string('teamsubmission', 'mod_mylkpd'));
        $mform->addHelpButton('teamsubmission', 'teamsubmission', 'mod_mylkpd');

        $mform->addElement('select', 'allowresubmit', get_string('allowresubmit', 'mod_mylkpd'), [
            1 => get_string('allowresubmituntilgraded', 'mod_mylkpd'),
            2 => get_string('allowresubmitalways', 'mod_mylkpd'),
            0 => get_string('allowresubmitno', 'mod_mylkpd'),
        ]);
        $mform->setDefault('allowresubmit', 1);
        $mform->addHelpButton('allowresubmit', 'allowresubmit', 'mod_mylkpd');

        // Changing these after students started would make existing answers unusable.
        if ($this->has_submissions()) {
            $mform->hardFreeze(['workmode', 'teamsubmission']);
            $mform->addElement('static', 'settingslocked', '', get_string('settingslocked', 'mod_mylkpd'));
        }

        $this->standard_grading_coursemodule_elements();
        $this->standard_coursemodule_elements();
        $this->add_action_buttons();
    }

    /**
     * Whether students already started this activity.
     *
     * @return bool
     */
    protected function has_submissions(): bool {
        global $DB;
        return !empty($this->current->instance)
            && $DB->record_exists('mylkpd_submissions', ['mylkpdid' => $this->current->instance]);
    }

    /**
     * Edit mode needs a .docx file.
     *
     * @param array $data
     * @param array $files
     * @return array
     */
    public function validation($data, $files) {
        $errors = parent::validation($data, $files);
        if (($data['workmode'] ?? '') === 'edit' && !empty($data['worksheet'])) {
            $draft = file_get_drafarea_files($data['worksheet']);
            $name = $draft->list ? reset($draft->list)->filename : '';
            if (core_text::strtolower(pathinfo($name, PATHINFO_EXTENSION)) !== 'docx') {
                $errors['workmode'] = get_string('editneedsdocx', 'mod_mylkpd');
            }
        }
        return $errors;
    }

    /**
     * Loads the existing worksheet into the file manager.
     *
     * @param array $defaults
     */
    public function data_preprocessing(&$defaults) {
        $draftitemid = file_get_submitted_draft_itemid('worksheet');
        $contextid = $this->current->instance ? $this->context->id : null;
        file_prepare_draft_area($draftitemid, $contextid, 'mod_mylkpd', 'worksheet', 0, mylkpd_filemanager_options());
        $defaults['worksheet'] = $draftitemid;
    }
}
