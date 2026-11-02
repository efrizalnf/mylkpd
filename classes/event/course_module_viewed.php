<?php
// This file is part of Moodle - https://moodle.org/

namespace mod_mylkpd\event;

/**
 * Fired when a user opens an LKPD activity.
 *
 * @package    mod_mylkpd
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
class course_module_viewed extends \core\event\course_module_viewed {

    /**
     * Init method.
     */
    protected function init() {
        $this->data['objecttable'] = 'mylkpd';
        parent::init();
    }

    /**
     * Backup/restore mapping.
     *
     * @return array
     */
    public static function get_objectid_mapping() {
        return ['db' => 'mylkpd', 'restore' => 'mylkpd'];
    }
}
